import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  canonicalBridgeJson,
  bridgeEventMessageSchema,
  bridgeConfigurationEventSchema,
  supportsBridgeOperation,
  type BridgeConfiguration,
  type BridgeEventMessage,
} from "@drone-fleet/protocol";
import {
  bridgeDefinitions as definitions,
  bridgeConfigurations as configurations,
  bridgeReports as reports,
  bridgeConfigurationHeads as heads,
  bridgeConflicts as conflicts,
  bridgeCommandConfigurations as bindings,
  commands,
  devices,
  bridgeActionEvents,
  rosCommandTargets,
  bridgeCancelEvents,
  rosCommandCancels,
  bridgeHealthEvents,
} from "./schema.js";
import type { Database } from "./connection.js";
import { appendAudit } from "./audit.js";
import { createBridgeExecutionRepository } from "./bridge-execution.js";
import { createRosCancelRepository } from "./ros-cancels.js";
import { createBridgeHealthRepository } from "./bridge-health.js";
import { rosReadiness, RosCommandError } from "./ros-commands.js";

export function bridgeDigest(value: unknown) {
  return createHash("sha256").update(canonicalBridgeJson(value)).digest("hex");
}
export class BridgeConfigurationError extends Error {}
function verified(configuration: BridgeConfiguration, deviceId: string) {
  if (
    configuration.deviceId !== deviceId ||
    configuration.namespace !==
      `/fleet/d_${Buffer.from(deviceId, "ascii").toString("hex")}` ||
    bridgeDigest(configuration.profile.definition) !==
      configuration.profile.digest
  )
    return false;
  return [configuration.operatingPolicy, configuration.safetyConfig].every(
    (p) => p.status !== "KNOWN" || bridgeDigest(p.definition) === p.digest,
  );
}
function documents(
  c: BridgeConfiguration,
): [string, Record<string, unknown>][] {
  const result: [string, Record<string, unknown>][] = [
    [
      `profile/${c.profile.definition.profileId}/${c.profile.definition.version}`,
      c.profile.definition,
    ],
  ];
  for (const name of [
    "bridge",
    "adapter",
    "operatingPolicy",
    "safetyConfig",
  ] as const) {
    const part = c[name];
    if (part.status === "KNOWN")
      result.push([`${name}/${part.id}/${part.version}`, part]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
export function createBridgeRepository(db: Database) {
  const executions = createBridgeExecutionRepository(db);
  const cancellations = createRosCancelRepository(db);
  const health = createBridgeHealthRepository(db);
  return {
    cancellations,
    health,
    executionState: executions.get,
    expireExecutions: executions.expire,
    async readiness(deviceId: string) {
      try {
        const ready = !!(await rosReadiness(
          db,
          deviceId,
          "RETURN_HOME",
          new Date(),
        ));
        return {
          ready,
          operationReason: ready ? "READY" : "ROS_CONFIGURATION_UNAVAILABLE",
        };
      } catch (error) {
        if (error instanceof RosCommandError)
          return { ready: false, operationReason: error.message };
        throw error;
      }
    },
    async save(input: BridgeEventMessage, receivedAt: Date) {
      const message = bridgeEventMessageSchema.parse(input);
      if (message.kind === "ROS_HEALTH")
        return health.save(message, receivedAt);
      if (message.kind === "CANCEL")
        return cancellations.save(message, receivedAt);
      if (message.kind !== "CONFIGURATION")
        return executions.save(message, receivedAt);
      if (
        !verified(message.configuration, message.deviceId) ||
        bridgeDigest(message.configuration) !== message.configurationId ||
        message.sequence !== message.reportSequence
      )
        throw new BridgeConfigurationError("CONFIGURATION_INVALID");
      const payloadHash = bridgeDigest(message);
      return db.transaction(async (tx) => {
        // eventの正本、device/current、version IDの順で全writerのlock順を固定する。
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bridge-event:${message.eventId}`},0))`,
        );
        if (
          (
            await tx
              .select()
              .from(bridgeHealthEvents)
              .where(eq(bridgeHealthEvents.eventId, message.eventId))
          ).length
        ) {
          await tx
            .insert(conflicts)
            .values({ eventId: message.eventId, payloadHash, receivedAt });
          return null;
        }
        const [cancelEvent] = await tx
          .select()
          .from(bridgeCancelEvents)
          .where(eq(bridgeCancelEvents.eventId, message.eventId));
        if (cancelEvent) {
          await tx
            .insert(conflicts)
            .values({ eventId: message.eventId, payloadHash, receivedAt });
          await tx
            .update(rosCommandCancels)
            .set({ assessment: "UNCERTAIN" })
            .where(eq(rosCommandCancels.cancelId, cancelEvent.cancelId));
          return null;
        }
        const [old] = await tx
          .select()
          .from(reports)
          .where(eq(reports.eventId, message.eventId));
        const [action] = await tx
          .select()
          .from(bridgeActionEvents)
          .where(eq(bridgeActionEvents.eventId, message.eventId));
        if (action) {
          await tx
            .insert(conflicts)
            .values({ eventId: message.eventId, payloadHash, receivedAt });
          return null;
        }
        if (old) {
          if (old.payloadHash !== payloadHash) {
            await tx
              .insert(conflicts)
              .values({ eventId: message.eventId, payloadHash, receivedAt });
            return null;
          }
          return {
            schemaVersion: 1 as const,
            deviceId: message.deviceId,
            eventId: message.eventId,
            payloadHash,
            status: "STORED" as const,
            timestamp: old.receivedAt.toISOString(),
          };
        }
        await tx
          .insert(devices)
          .values({ deviceId: message.deviceId })
          .onConflictDoNothing();
        await tx
          .select({ deviceId: devices.deviceId })
          .from(devices)
          .where(eq(devices.deviceId, message.deviceId))
          .for("update");
        await tx
          .insert(heads)
          .values({ deviceId: message.deviceId })
          .onConflictDoNothing();
        const [head] = await tx
          .select()
          .from(heads)
          .where(eq(heads.deviceId, message.deviceId))
          .for("update");
        let conflict = false;
        for (const [key, document] of documents(message.configuration)) {
          await tx
            .insert(definitions)
            .values({ key, document })
            .onConflictDoNothing();
          const [existing] = await tx
            .select()
            .from(definitions)
            .where(eq(definitions.key, key));
          if (bridgeDigest(existing!.document) !== bridgeDigest(document))
            conflict = true;
        }
        const [existingConfiguration] = await tx
          .select()
          .from(configurations)
          .where(eq(configurations.configurationId, message.configurationId));
        if (
          existingConfiguration &&
          bridgeDigest(existingConfiguration.snapshot) !==
            message.configurationId
        )
          conflict = true;
        const [active] = await tx
          .select({ commandId: bindings.commandId })
          .from(bindings)
          .innerJoin(commands, eq(commands.commandId, bindings.commandId))
          .where(
            and(
              eq(commands.deviceId, message.deviceId),
              eq(bindings.stopConfirmed, false),
            ),
          )
          .limit(1);
        const [reserved] = await tx
          .select()
          .from(rosCommandTargets)
          .where(
            and(
              eq(rosCommandTargets.deviceId, message.deviceId),
              eq(rosCommandTargets.stopConfirmed, false),
              eq(rosCommandTargets.notStarted, false),
            ),
          )
          .limit(1);
        const stale =
          message.configurationRevision < head!.configurationRevision ||
          message.reportSequence <= head!.reportSequence ||
          (message.configurationRevision === head!.configurationRevision &&
            message.configurationId !== head!.configurationId);
        const clockInvalid =
          Math.abs(
            receivedAt.getTime() - new Date(message.timestamp).getTime(),
          ) > 15000;
        const disposition = conflict
          ? "CONFLICT"
          : head!.journalId && head!.journalId !== message.journalId
            ? "JOURNAL_MISMATCH"
            : stale
              ? "STALE"
              : (active || reserved) &&
                  head!.configurationId !== message.configurationId
                ? "ACTIVE_EXECUTION"
                : clockInvalid
                  ? "CLOCK_INVALID"
                  : "CURRENT";
        if (!conflict)
          await tx
            .insert(configurations)
            .values({
              configurationId: message.configurationId,
              deviceId: message.deviceId,
              snapshot: message.configuration,
            })
            .onConflictDoNothing();
        await tx.insert(reports).values({
          eventId: message.eventId,
          deviceId: message.deviceId,
          payloadHash,
          message,
          receivedAt,
          disposition,
        });
        if (disposition === "CURRENT")
          await tx
            .update(heads)
            .set({
              journalId: message.journalId,
              reportEventId: message.eventId,
              configurationId: message.configurationId,
              configurationRevision: message.configurationRevision,
              reportSequence: message.reportSequence,
              reportedAt: receivedAt,
            })
            .where(eq(heads.deviceId, message.deviceId));
        return {
          schemaVersion: 1 as const,
          deviceId: message.deviceId,
          eventId: message.eventId,
          payloadHash,
          status: "STORED" as const,
          timestamp: receivedAt.toISOString(),
        };
      });
    },
    async get(deviceId: string) {
      const [device] = await db
        .select({ deviceId: devices.deviceId })
        .from(devices)
        .where(eq(devices.deviceId, deviceId));
      if (!device) return null;
      const [head] = await db
        .select()
        .from(heads)
        .where(eq(heads.deviceId, deviceId));
      const [configuration] = head?.configurationId
        ? await db
            .select()
            .from(configurations)
            .where(eq(configurations.configurationId, head.configurationId))
        : [];
      return {
        desired: head?.desiredId
          ? { configurationId: head.desiredId, revision: head.desiredRevision }
          : null,
        reported: configuration
          ? {
              configurationId: configuration.configurationId,
              configurationRevision: head!.configurationRevision,
              reportSequence: head!.reportSequence,
              receivedAt: head!.reportedAt?.toISOString(),
              configuration: configuration.snapshot,
            }
          : null,
        matchesDesired: head?.desiredId
          ? head.desiredId === head.configurationId
          : null,
      };
    },
    async history(deviceId: string, limit: number) {
      return db
        .select()
        .from(reports)
        .where(eq(reports.deviceId, deviceId))
        .orderBy(desc(reports.receivedAt), asc(reports.eventId))
        .limit(limit);
    },
    async desired(deviceId: string, revision: number, configurationId: string) {
      await db.transaction(async (tx) => {
        const [device] = await tx
          .select({ deviceId: devices.deviceId })
          .from(devices)
          .where(eq(devices.deviceId, deviceId))
          .for("update");
        if (!device) throw new BridgeConfigurationError("DEVICE_NOT_FOUND");
        await tx.insert(heads).values({ deviceId }).onConflictDoNothing();
        const [head] = await tx
          .select()
          .from(heads)
          .where(eq(heads.deviceId, deviceId))
          .for("update");
        if (
          revision < head!.desiredRevision ||
          (revision === head!.desiredRevision &&
            head!.desiredId !== configurationId)
        )
          throw new BridgeConfigurationError("DESIRED_CONFLICT");
        await tx
          .update(heads)
          .set({ desiredId: configurationId, desiredRevision: revision })
          .where(eq(heads.deviceId, deviceId));
        if (
          revision !== head!.desiredRevision ||
          configurationId !== head!.desiredId
        )
          await appendAudit(tx, {
            action: "bridge.desired_changed",
            targetKind: "device",
            targetId: deviceId,
            metadata: { reason: "DESIRED_CONFIGURATION_CHANGED" },
          });
      });
    },
    // #194の開始処理から呼ぶ境界。HTTPやBridgeから架空の実行を作らない。
    async bindExecution(
      commandId: string,
      goalId: string,
      configurationId: string,
      startedAt: Date,
    ) {
      bridgeConfigurationEventSchema.shape.eventId.parse(goalId);
      return db.transaction(async (tx) => {
        const [command] = await tx
          .select()
          .from(commands)
          .where(eq(commands.commandId, commandId));
        if (!command) throw new BridgeConfigurationError("COMMAND_NOT_FOUND");
        await tx
          .select({ deviceId: devices.deviceId })
          .from(devices)
          .where(eq(devices.deviceId, command.deviceId))
          .for("update");
        const [previous] = await tx
          .select()
          .from(bindings)
          .where(eq(bindings.commandId, commandId));
        if (previous) {
          if (
            previous.goalId !== goalId ||
            previous.configurationId !== configurationId ||
            previous.startedAt.getTime() !== startedAt.getTime()
          )
            throw new BridgeConfigurationError("EXECUTION_CONFLICT");
          return previous;
        }
        const [head] = await tx
          .select()
          .from(heads)
          .where(eq(heads.deviceId, command.deviceId));
        const [configuration] = await tx
          .select()
          .from(configurations)
          .where(eq(configurations.configurationId, configurationId));
        if (
          !head ||
          head.configurationId !== configurationId ||
          (head.desiredId !== null && head.desiredId !== configurationId) ||
          !head.reportedAt ||
          startedAt < head.reportedAt ||
          startedAt.getTime() - head.reportedAt.getTime() >= 15000 ||
          !configuration ||
          !supportsBridgeOperation(configuration.snapshot, command.type)
        )
          throw new BridgeConfigurationError("CONFIGURATION_UNAVAILABLE");
        if (!head.reportEventId)
          throw new BridgeConfigurationError("CONFIGURATION_UNAVAILABLE");
        const [active] = await tx
          .select({ commandId: bindings.commandId })
          .from(bindings)
          .innerJoin(commands, eq(commands.commandId, bindings.commandId))
          .where(
            and(
              eq(commands.deviceId, command.deviceId),
              eq(bindings.stopConfirmed, false),
            ),
          )
          .limit(1);
        if (active) throw new BridgeConfigurationError("ACTIVE_EXECUTION");
        const [bound] = await tx
          .insert(bindings)
          .values({
            commandId,
            goalId,
            configurationId,
            reportEventId: head.reportEventId,
            startedAt,
          })
          .returning();
        return bound!;
      });
    },
    async execution(commandId: string) {
      const [row] = await db
        .select({ binding: bindings, configuration: configurations.snapshot })
        .from(bindings)
        .innerJoin(
          configurations,
          eq(bindings.configurationId, configurations.configurationId),
        )
        .where(eq(bindings.commandId, commandId));
      return row ?? null;
    },
  };
}
export type BridgeRepository = ReturnType<typeof createBridgeRepository>;
