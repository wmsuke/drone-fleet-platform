// DB境界の合成fixture。実ROSの証明はtest:ros-commandsで別に検証する。
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  createBridgeRepository,
  bridgeDigest,
  devices,
  commands,
  commandOutbox,
  rosObservations,
  rosCommandTargets,
  bridgeActionEvents,
  bridgeCommandConfigurations,
  rosCommandCancels,
  bridgeCancelEvents,
} from "@drone-fleet/database";
import {
  bridgeConfigurationEventSchema,
  bridgeActionEventSchema,
  bridgeCancelEventSchema,
  bridgeHealthEventSchema,
  rosObservationMessageSchema,
} from "@drone-fleet/protocol";
import { report } from "../../../packages/protocol/test/fixtures/bridge.mjs";
import { healthMessage } from "../../../packages/protocol/test/fixtures/bridge-health.mjs";
import { buildApi } from "../../api/src/app.js";
import { createDeviceRepository } from "../../api/src/repository.js";
import { createCommandRepository } from "../../api/src/command-repository.js";
import { createCommandService } from "../../api/src/command-service.js";
import { createCommandAcknowledgementRepository } from "../src/acknowledgement.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const ids: string[] = [],
  commandIds: string[] = [],
  apps: ReturnType<typeof buildApi>[] = [];
describe.skipIf(!enabled)(
  "ROS command acceptance and immutable evidence",
  () => {
    beforeAll(async () => {
      await migrate(database!.db, {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/drizzle", import.meta.url),
        ),
      });
    });
    afterAll(async () => {
      for (const app of apps) await app.close();
      for (const id of commandIds) {
        const [cancel] = await database!.db
          .select()
          .from(rosCommandCancels)
          .where(eq(rosCommandCancels.commandId, id));
        if (cancel) {
          await database!.db
            .delete(bridgeCancelEvents)
            .where(eq(bridgeCancelEvents.cancelId, cancel.cancelId));
          await database!.db
            .delete(rosCommandCancels)
            .where(eq(rosCommandCancels.commandId, id));
        }
        await database!.db
          .delete(bridgeActionEvents)
          .where(eq(bridgeActionEvents.commandId, id));
        await database!.db
          .delete(bridgeCommandConfigurations)
          .where(eq(bridgeCommandConfigurations.commandId, id));
        await database!.db
          .delete(rosCommandTargets)
          .where(eq(rosCommandTargets.commandId, id));
        await database!.db.delete(commands).where(eq(commands.commandId, id));
      }
      for (const id of ids)
        await database!.db.delete(devices).where(eq(devices.deviceId, id));
      await database!.client.end();
    });
    async function fixture() {
      const db = database!.db,
        repo = createBridgeRepository(db),
        at = new Date(),
        source = new Date(at.getTime() - 1000);
      const id = `action-db-${randomUUID().slice(0, 8)}`;
      ids.push(id);
      const config = bridgeConfigurationEventSchema.parse({
        ...report(bridgeDigest, id),
        eventId: randomUUID(),
        journalId: randomUUID(),
        timestamp: source.toISOString(),
      });
      await repo.save(config, source);
      const q = {
        reason: "VALID",
        stamp: { sec: Math.floor(source.getTime() / 1000), nanosec: 0 },
        timeDomain: "SYSTEM",
        clockEpoch: 0,
        receivedAt: source.toISOString(),
      };
      const message = rosObservationMessageSchema.parse({
        schemaVersion: 3,
        deviceId: id,
        sessionId: randomUUID(),
        sequence: 0,
        timestamp: source.toISOString(),
        payload: {
          source: "ROS2",
          battery: 80,
          temperature: 24,
          flightStatus: "IDLE",
          diagnostics: [],
          diagnosticsTruncated: false,
          position: {
            kind: "LOCAL",
            frameId: config.configuration.namespace.slice(1) + "/map",
            convention: "ENU",
            unit: "m",
            pose: { x: 0, y: 0, z: 0 },
            velocity: null,
          },
          quality: {
            battery: q,
            temperature: q,
            position: q,
            flightStatus: q,
            diagnostics: q,
          },
        },
      });
      await db.insert(rosObservations).values({
        deviceId: id,
        sessionId: message.sessionId,
        sequence: 0,
        deviceTimestamp: source,
        receivedAt: source,
        isRetained: false,
        payload: message.payload,
      });
      await db
        .update(devices)
        .set({ connectionStatus: "ONLINE", lastReceivedAt: source })
        .where(eq(devices.deviceId, id));
      const app = buildApi(
        createDeviceRepository(db),
        createCommandService(createCommandRepository(db), randomUUID, () => at),
        { bridgeRepository: repo },
      );
      apps.push(app);
      const created = await app.inject({
        method: "POST",
        url: `/devices/${id}/commands`,
        payload: { type: "RETURN_HOME" },
      });
      expect(created.statusCode).toBe(202);
      const commandId = created.json().commandId;
      commandIds.push(commandId);
      const goalId = randomUUID();
      const time = (seconds: number) => new Date(at.getTime() + seconds * 1000);
      const base = {
        schemaVersion: 1,
        deviceId: id,
        eventId: randomUUID(),
        sessionId: randomUUID(),
        journalId: config.journalId,
        sequence: 2,
        configurationId: config.configurationId,
        commandId,
        goalId,
        serverInstanceId: config.configuration.serverInstanceId,
        timestamp: time(5).toISOString(),
      };
      const event = (fields: Record<string, unknown>) =>
        bridgeActionEventSchema.parse({
          ...base,
          eventId: randomUUID(),
          ...fields,
        });
      const evidence = {
        cdr: "dW5pdA==",
        hash: createHash("sha256").update("unit").digest("hex"),
        rosStatus: 4,
        started: true,
        startedAt: time(1).toISOString(),
        finishedAt: time(5).toISOString(),
        poseFrame: config.configuration.namespace.slice(1) + "/map",
        velocityFrame: config.configuration.namespace.slice(1) + "/map",
        homeId: config.configuration.homeId,
        poseMm: { x: 0, y: 0, z: 0 },
        velocityMmPerSecond: { x: 0, y: 0, z: 0 },
        homeDistanceMm: 0,
        speedMmPerSecond: 0,
        stableDurationMs: 1000,
      };
      return {
        db,
        repo,
        app,
        id,
        commandId,
        goalId,
        config,
        at,
        time,
        event,
        evidence,
      };
    }
    it("health/action ID collision keeps evidence and prevents release of a rejected target", async () => {
      const f = await fixture();
      const rejection = f.event({
        kind: "GOAL_REJECTED",
        reason: "ACTION_REJECTED",
      });
      await f.repo.save(rejection, f.time(5));
      expect(
        (await f.repo.executionState(f.commandId))?.target.notStarted,
      ).toBe(true);
      const forged = bridgeHealthEventSchema.parse({
        ...healthMessage,
        deviceId: f.id,
        eventId: rejection.eventId,
        journalId: f.config.journalId,
        configurationId: f.config.configurationId,
        timestamp: f.time(5).toISOString(),
      });
      expect(await f.repo.save(forged, f.time(5))).toBeNull();
      const state = await f.repo.executionState(f.commandId);
      expect(state?.target).toMatchObject({
        conflicted: true,
        notStarted: false,
        stopConfirmed: false,
      });
      expect(state?.recovery.humanReviewRequired).toBe(true);
      expect(state?.recovery.reason).toBe("EVENT_CONFLICT");
      expect(state?.events).toHaveLength(1);
    });
    it("keeps idempotent cancel acceptance distinct from result/stop and preserves late responses", async () => {
      const f = await fixture(),
        path = `/devices/${f.id}/commands/${f.commandId}/cancel`;
      const post = (key = "fixed", reason = "OPERATOR_REQUEST") =>
        f.app.inject({
          method: "POST",
          url: path,
          headers: { "idempotency-key": key },
          payload: { reason },
        });
      expect((await post()).statusCode).toBe(409);
      await f.repo.save(
        f.event({
          kind: "GOAL_ACCEPTED",
          reason: "GOAL_ACCEPTED",
          timestamp: f.time(0.1).toISOString(),
        }),
        f.time(0.1),
      );
      const results = await Promise.all([post(), post()]);
      expect(results.map((r) => r.statusCode)).toEqual([202, 202]);
      const first = results[0]!.json().state;
      expect(results[1]!.json().cancelId).toBe(first.cancelId);
      expect((await post("fixed", "DIFFERENT_REASON")).statusCode).toBe(409);
      expect((await post("different")).statusCode).toBe(409);
      const request = first.request;
      const message = bridgeCancelEventSchema.parse({
        ...f.event({ kind: "GOAL_ACCEPTED", reason: "GOAL_ACCEPTED" }),
        timestamp: new Date(Date.parse(request.timestamp) + 1000).toISOString(),
        kind: "CANCEL",
        phase: "ACCEPTED",
        reason: "CANCEL_ACCEPTED",
        requestId: request.requestId,
        cancelId: request.cancelId,
        attempt: 1,
        response: {
          returnCode: 0,
          goalsCanceling: [f.goalId],
          cdr: "dW5pdA==",
          hash: createHash("sha256").update("unit").digest("hex"),
        },
      });
      const receipt = await f.repo.save(message, new Date(message.timestamp));
      expect(await f.repo.save(message, new Date(message.timestamp))).toEqual(
        receipt,
      );
      let state = (await f.repo.cancellations.get(
        f.id,
        f.commandId,
        new Date(message.timestamp),
      ))!;
      expect(state).toMatchObject({
        phase: "ACCEPTED",
        assessment: "PENDING",
        terminalStatus: "NOT_REPORTED",
        stopConfirmation: "UNKNOWN",
        actorKind: "anonymous",
        actorId: null,
      });
      state = (await f.repo.cancellations.get(
        f.id,
        f.commandId,
        new Date(Date.parse(request.expiresAt) + 1),
      ))!;
      expect(state).toMatchObject({
        assessment: "UNCERTAIN",
        terminalStatus: "NOT_REPORTED",
        humanReviewRequired: true,
      });
      const late = { ...message, eventId: randomUUID() };
      await f.repo.save(late, new Date(Date.parse(request.expiresAt) + 2000));
      state = (await f.repo.cancellations.get(
        f.id,
        f.commandId,
        new Date(Date.parse(request.expiresAt) + 2001),
      ))!;
      expect(state.assessment).toBe("UNCERTAIN");
      const history = await f.app.inject(`/devices/${f.id}/commands`);
      expect(history.statusCode).toBe(200);
      expect(history.json()[0].cancellation).toMatchObject({
        assessment: "UNCERTAIN",
        humanReviewRequired: true,
        stopConfirmation: "UNKNOWN",
      });
      expect(state.events.some((e) => e.disposition === "LATE")).toBe(true);
      await expect(
        f.db
          .update(rosCommandCancels)
          .set({ request: { ...request, goalId: randomUUID() } })
          .where(eq(rosCommandCancels.cancelId, first.cancelId)),
      ).rejects.toThrow();
      await expect(
        f.db
          .update(bridgeCancelEvents)
          .set({ disposition: "OTHER" })
          .where(eq(bridgeCancelEvents.eventId, message.eventId)),
      ).rejects.toThrow();
      expect(
        await f.repo.save({ ...f.config, eventId: message.eventId }, f.time(9)),
      ).toBeNull();
    });
    it("retains cancel rejection but requires human review if no terminal and stop arrive", async () => {
      const f = await fixture();
      await f.repo.save(
        f.event({
          kind: "GOAL_ACCEPTED",
          reason: "GOAL_ACCEPTED",
          timestamp: f.time(0.1).toISOString(),
        }),
        f.time(0.1),
      );
      const r = await f.repo.cancellations.create(
        f.id,
        f.commandId,
        "reject-timeout",
        "OPERATOR_REQUEST",
        f.time(0.2),
      );
      const event = bridgeCancelEventSchema.parse({
        ...f.event({ kind: "GOAL_ACCEPTED", reason: "GOAL_ACCEPTED" }),
        kind: "CANCEL",
        phase: "REJECTED",
        reason: "CANCEL_REJECTED",
        requestId: r.cancelId,
        cancelId: r.cancelId,
        attempt: 1,
        response: {
          returnCode: 1,
          goalsCanceling: [],
          cdr: "dW5pdA==",
          hash: createHash("sha256").update("unit").digest("hex"),
        },
      });
      await f.repo.save(event, f.time(5));
      expect(
        (await f.repo.cancellations.get(f.id, f.commandId, f.time(6)))!
          .assessment,
      ).toBe("REJECTED");
      expect(
        await f.repo.cancellations.get(f.id, f.commandId, f.time(11)),
      ).toMatchObject({
        phase: "REJECTED",
        assessment: "UNCERTAIN",
        humanReviewRequired: true,
        terminalStatus: "NOT_REPORTED",
        stopConfirmation: "UNKNOWN",
      });
    });
    it("bounds cancel transport attempts across worker instances without changing the command", async () => {
      const f = await fixture();
      await f.repo.save(
        f.event({
          kind: "GOAL_ACCEPTED",
          reason: "GOAL_ACCEPTED",
          timestamp: f.time(0.1).toISOString(),
        }),
        f.time(0.1),
      );
      const at = f.time(1),
        r = await f.repo.cancellations.create(
          f.id,
          f.commandId,
          "bounded",
          "OPERATOR_REQUEST",
          at,
        );
      const sent: string[] = [];
      for (const offset of [1, 4, 7, 9])
        await createBridgeRepository(f.db).cancellations.dispatch(
          async (topic, body) => {
            sent.push(body);
            expect(topic).toBe(`fleet/v1/devices/${f.id}/bridge-requests`);
          },
          () => f.time(offset),
        );
      expect(sent).toHaveLength(3);
      expect(new Set(sent).size).toBe(1);
      const state = (await f.repo.cancellations.get(
        f.id,
        f.commandId,
        f.time(12),
      ))!;
      expect(state).toMatchObject({
        cancelId: r.cancelId,
        attempts: 3,
        assessment: "UNCERTAIN",
        terminalStatus: "NOT_REPORTED",
        stopConfirmation: "UNKNOWN",
      });
    });
    it("does not erase a terminal success when a cancel response arrives before or after it", async () => {
      for (const acceptedFirst of [true, false]) {
        const f = await fixture();
        await f.repo.save(
          f.event({
            kind: "GOAL_ACCEPTED",
            reason: "GOAL_ACCEPTED",
            timestamp: f.time(0.1).toISOString(),
          }),
          f.time(0.1),
        );
        const r = await f.repo.cancellations.create(
          f.id,
          f.commandId,
          "race",
          "OPERATOR_REQUEST",
          f.time(0.2),
        );
        const cancel = bridgeCancelEventSchema.parse({
          ...f.event({ kind: "GOAL_ACCEPTED", reason: "GOAL_ACCEPTED" }),
          kind: "CANCEL",
          phase: "ACCEPTED",
          reason: "CANCEL_ACCEPTED",
          requestId: r.cancelId,
          cancelId: r.cancelId,
          attempt: 1,
          response: {
            returnCode: 0,
            goalsCanceling: [f.goalId],
            cdr: "dW5pdA==",
            hash: createHash("sha256").update("unit").digest("hex"),
          },
        });
        const success = f.event({
          kind: "EXECUTION",
          status: "SUCCEEDED",
          reason: "HOME_REACHED",
          startedAt: f.time(1).toISOString(),
          result: f.evidence,
        });
        if (acceptedFirst) await f.repo.save(cancel, f.time(4));
        await f.repo.save(success, f.time(5));
        if (!acceptedFirst) await f.repo.save(cancel, f.time(5.1));
        expect(
          (await f.repo.executionState(f.commandId))!.command.executionStatus,
        ).toBe("SUCCEEDED");
        expect(
          (await f.repo.cancellations.get(f.id, f.commandId, f.time(6)))!
            .stopConfirmation,
        ).toBe("UNKNOWN");
      }
    });
    it("routes v3, separates receipt/accept/feedback/result/stop, and defers an out-of-order stop", async () => {
      const f = await fixture();
      const [outbox] = await f.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.commandId, f.commandId));
      expect(JSON.parse(outbox!.payload)).toMatchObject({
        schemaVersion: 3,
        targetKind: "ROS2",
        expectedConfigurationId: f.config.configurationId,
      });
      const ack = createCommandAcknowledgementRepository(f.db);
      expect(
        await ack.acknowledge(
          {
            schemaVersion: 3,
            deviceId: f.id,
            commandId: f.commandId,
            status: "RUNNING",
            timestamp: f.time(2).toISOString(),
            startedAt: f.time(1).toISOString(),
          },
          f.time(2),
        ),
      ).toBe("conflict");
      expect(
        await ack.acknowledge(
          {
            schemaVersion: 2,
            deviceId: f.id,
            commandId: f.commandId,
            status: "ACKNOWLEDGED",
            timestamp: f.time(0.5).toISOString(),
          },
          f.time(0.5),
        ),
      ).toBe("updated");
      await f.repo.save(
        f.event({
          kind: "GOAL_ACCEPTED",
          reason: "GOAL_ACCEPTED",
          timestamp: f.time(0.8).toISOString(),
        }),
        f.time(0.8),
      );
      expect(
        (await f.repo.executionState(f.commandId))!.command.executionStatus,
      ).toBe("NOT_REPORTED");
      await f.repo.save(
        f.event({
          kind: "FEEDBACK",
          reason: "FEEDBACK",
          startedAt: f.time(1).toISOString(),
          distanceMm: 2000,
          timestamp: f.time(2).toISOString(),
        }),
        f.time(2),
      );
      expect(
        (await f.repo.executionState(f.commandId))!.command.executionStatus,
      ).toBe("RUNNING");
      const terminal = f.event({
        kind: "EXECUTION",
        status: "SUCCEEDED",
        reason: "HOME_REACHED",
        startedAt: f.time(1).toISOString(),
        result: f.evidence,
      });
      const stop = f.event({
        kind: "STOP_OBSERVATION",
        reason: "STOP_OBSERVED",
        timestamp: f.time(6.2).toISOString(),
        terminalEventId: terminal.eventId,
        flightStatus: "IDLE",
        speedMmPerSecond: 0,
        dwellMs: 1100,
        poseFrame: f.evidence.poseFrame,
        firstSampleAt: f.time(5.1).toISOString(),
        lastSampleAt: f.time(6.2).toISOString(),
      });
      expect(await f.repo.save(stop, f.time(6.2))).toBeNull();
      expect(
        (await f.repo.executionState(f.commandId))!.target.stopConfirmed,
      ).toBe(false);
      const receipt = await f.repo.save(terminal, f.time(5));
      expect(await f.repo.save(terminal, f.time(7))).toEqual(receipt);
      const blocked = await f.app.inject({
        method: "POST",
        url: `/devices/${f.id}/commands`,
        payload: { type: "RETURN_HOME" },
      });
      expect(blocked.statusCode).toBe(409);
      await f.repo.save(stop, f.time(6.2));
      const result = (await f.repo.executionState(f.commandId))!;
      expect(result.target).toMatchObject({
        stopConfirmed: true,
        notStarted: false,
      });
      expect(result.command.executionStatus).toBe("SUCCEEDED");
      expect(
        result.events.filter((e) => e.message.eventId === terminal.eventId),
      ).toHaveLength(1);
      expect((await f.repo.execution(f.commandId))!.binding.startedAt).toEqual(
        f.time(1),
      );
    });
    it("keeps explicit rejection not-started without manufacturing stop or startedAt", async () => {
      const f = await fixture();
      await f.repo.save(
        f.event({ kind: "GOAL_REJECTED", reason: "ACTION_REJECTED" }),
        f.time(5),
      );
      const result = (await f.repo.executionState(f.commandId))!;
      expect(result.command).toMatchObject({
        executionStatus: "REJECTED",
        executionStartedAt: null,
      });
      expect(result.target).toMatchObject({
        notStarted: true,
        stopConfirmed: false,
      });
      expect(await f.repo.execution(f.commandId)).toBeNull();
    });
    it("preserves canonical results and blocks a conflicting body and mutation", async () => {
      const f = await fixture();
      const event = f.event({
        kind: "EXECUTION",
        status: "SUCCEEDED",
        reason: "HOME_REACHED",
        startedAt: f.time(1).toISOString(),
        result: f.evidence,
      });
      await f.repo.save(event, f.time(5));
      expect(
        await f.repo.save({ ...event, reason: "INJECTED_FAILURE" }, f.time(6)),
      ).toBeNull();
      const result = (await f.repo.executionState(f.commandId))!;
      expect(result.command.executionStatus).toBe("SUCCEEDED");
      expect(result.target).toMatchObject({
        conflicted: true,
        stopConfirmed: false,
        notStarted: false,
      });
      expect(result.events[0]!.message).toEqual(event);
      await expect(
        f.db
          .update(bridgeActionEvents)
          .set({ disposition: "OTHER" })
          .where(eq(bridgeActionEvents.eventId, event.eventId)),
      ).rejects.toThrow();
      await expect(
        f.db
          .update(rosCommandTargets)
          .set({ goalId: randomUUID() })
          .where(eq(rosCommandTargets.commandId, f.commandId)),
      ).rejects.toThrow();
    });
    it("retains unreported expiration as uncertain and stores late proof without upgrading it", async () => {
      const f = await fixture();
      await f.repo.expireExecutions(f.time(120));
      await f.repo.save(
        f.event({
          kind: "EXECUTION",
          status: "SUCCEEDED",
          reason: "HOME_REACHED",
          startedAt: f.time(1).toISOString(),
          result: f.evidence,
        }),
        f.time(121),
      );
      const result = (await f.repo.executionState(f.commandId))!;
      expect(result.command).toMatchObject({
        executionStatus: "UNCERTAIN",
        executionStartedAt: null,
      });
      expect(result.target.stopConfirmed).toBe(false);
      expect(result.events[0]!.disposition).toBe("LATE");
      expect(await f.repo.execution(f.commandId)).toBeNull();
    });
    it("does not project a different journal or corrupted result hash", async () => {
      const f = await fixture();
      await f.repo.save(
        f.event({
          kind: "GOAL_ACCEPTED",
          reason: "GOAL_ACCEPTED",
          journalId: randomUUID(),
        }),
        f.time(5),
      );
      expect(
        (await f.repo.executionState(f.commandId))!.command.executionStatus,
      ).toBe("NOT_REPORTED");
      await f.repo.save(
        f.event({
          kind: "EXECUTION",
          status: "SUCCEEDED",
          reason: "HOME_REACHED",
          startedAt: f.time(1).toISOString(),
          result: { ...f.evidence, hash: "f".repeat(64) },
        }),
        f.time(5),
      );
      const result = (await f.repo.executionState(f.commandId))!;
      expect(result.command.executionStatus).toBe("NOT_REPORTED");
      expect(result.events.map((e) => e.disposition).sort()).toEqual([
        "CONFLICT",
        "UNMATCHED",
      ]);
    });
    it("accepts ROS ACK v2 expiration as a not-started proof, including after outbox expiration", async () => {
      const f = await fixture();
      await f.db
        .update(commands)
        .set({ status: "EXPIRED", expiredAt: f.time(30) })
        .where(eq(commands.commandId, f.commandId));
      expect(
        await createCommandAcknowledgementRepository(f.db).acknowledge(
          {
            schemaVersion: 2,
            deviceId: f.id,
            commandId: f.commandId,
            status: "REJECTED_EXPIRED",
            timestamp: f.time(31).toISOString(),
          },
          f.time(31),
        ),
      ).toBe("updated");
      const result = (await f.repo.executionState(f.commandId))!;
      expect(result.command).toMatchObject({
        executionStatus: "REJECTED",
        executionStartedAt: null,
      });
      expect(result.target).toMatchObject({
        notStarted: true,
        stopConfirmed: false,
        goalId: null,
      });
    });
  },
);
