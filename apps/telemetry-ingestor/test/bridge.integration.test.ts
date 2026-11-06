import { randomUUID } from "node:crypto";
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
  bridgeCommandConfigurations,
  bridgeReports,
  bridgeConflicts,
  bridgeConfigurations,
  auditLogs,
} from "@drone-fleet/database";
import { bridgeEventMessageSchema } from "@drone-fleet/protocol";
import { report } from "../../../packages/protocol/test/fixtures/bridge.mjs";
import { buildApi } from "../../api/src/app.js";
import { createDeviceRepository } from "../../api/src/repository.js";
import { createCommandRepository } from "../../api/src/command-repository.js";
import { createCommandService } from "../../api/src/command-service.js";
import { ingestBridge } from "../src/bridge.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const deviceId = `bridge-integration-${randomUUID().slice(0, 8)}`;
const commandIds: string[] = [];
describe.skipIf(!enabled)(
  "Bridge configuration persistence and HTTP API",
  () => {
    beforeAll(async () => {
      await migrate(database!.db, {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/drizzle", import.meta.url),
        ),
      });
    });
    afterAll(async () => {
      for (const id of commandIds) {
        await database!.db
          .delete(bridgeCommandConfigurations)
          .where(eq(bridgeCommandConfigurations.commandId, id));
        await database!.db.delete(commands).where(eq(commands.commandId, id));
      }
      await database!.db.delete(devices).where(eq(devices.deviceId, deviceId));
      await database!.client.end();
    });
    it("keeps reported, desired and execution snapshots independent across updates and rejects old/conflicting identity", async () => {
      const db = database!.db;
      const repo = createBridgeRepository(db);
      const original = bridgeEventMessageSchema.parse({
        ...report(bridgeDigest, deviceId),
        eventId: randomUUID(),
      });
      const at = new Date(original.timestamp);
      const next = (revision: number, sequence: number) => ({
        ...original,
        eventId: randomUUID(),
        configurationRevision: revision,
        reportSequence: sequence,
        sequence,
      });
      const firstReceipt = await repo.save(original, at);
      expect(await repo.save(original, new Date(at.getTime() + 1000))).toEqual(
        firstReceipt,
      );
      expect(
        await repo.save({ ...original, sequence: 2, reportSequence: 2 }, at),
      ).toBeNull();
      expect(
        await db
          .select()
          .from(bridgeConflicts)
          .where(eq(bridgeConflicts.eventId, original.eventId)),
      ).toHaveLength(1);
      const app = buildApi(
        createDeviceRepository(db),
        createCommandService(createCommandRepository(db)),
        { bridgeRepository: repo },
      );
      try {
        const status = await app.inject(
          `/devices/${deviceId}/bridge-configuration`,
        );
        expect(status.statusCode).toBe(200);
        expect(status.json()).toMatchObject({
          supportedOperations: ["RETURN_HOME"],
          ready: false,
          matchesDesired: null,
        });
        const commandId = randomUUID();
        commandIds.push(commandId);
        await db.insert(commands).values({
          commandId,
          deviceId,
          type: "RETURN_HOME",
          createdAt: at,
          expiresAt: new Date(at.getTime() + 30000),
        });
        const goalId = randomUUID();
        await repo.bindExecution(
          commandId,
          goalId,
          original.configurationId,
          at,
        );
        const updated = next(2, 2);
        updated.configuration = {
          ...updated.configuration,
          adapterConfigurationId: "d".repeat(64),
        };
        updated.configurationId = bridgeDigest(updated.configuration);
        await repo.save(updated, at);
        expect((await repo.get(deviceId))!.reported!.configurationId).toBe(
          original.configurationId,
        );
        expect(
          (await repo.history(deviceId, 100)).find(
            (r) => r.eventId === updated.eventId,
          )!.disposition,
        ).toBe("ACTIVE_EXECUTION");
        // 完了・停止確認済みの実行fixture。実Actionの開始/停止処理自体は#194以降。
        await db
          .update(bridgeCommandConfigurations)
          .set({ stopConfirmed: true })
          .where(eq(bridgeCommandConfigurations.commandId, commandId));
        const accepted = {
          ...updated,
          eventId: randomUUID(),
          reportSequence: 3,
          sequence: 3,
        };
        await repo.save(accepted, at);
        expect((await repo.get(deviceId))!.reported!.configurationId).toBe(
          updated.configurationId,
        );
        const execution = await app.inject(
          `/commands/${commandId}/bridge-configuration`,
        );
        expect(execution.json()).toMatchObject({
          binding: { goalId, configurationId: original.configurationId },
          configuration: original.configuration,
        });
        await expect(
          repo.bindExecution(
            commandId,
            randomUUID(),
            updated.configurationId,
            at,
          ),
        ).rejects.toThrow("EXECUTION_CONFLICT");
        const stale = next(1, 4);
        await repo.save(stale, at);
        expect((await repo.get(deviceId))!.reported!.configurationId).toBe(
          updated.configurationId,
        );
        const reset = {
          ...accepted,
          eventId: randomUUID(),
          journalId: randomUUID(),
          configurationRevision: 3,
          reportSequence: 100,
          sequence: 100,
        };
        await repo.save(reset, at);
        expect(
          (await repo.history(deviceId, 100)).find(
            (r) => r.eventId === reset.eventId,
          )!.disposition,
        ).toBe("JOURNAL_MISMATCH");
        const conflict = next(3, 5);
        conflict.configuration = {
          ...conflict.configuration,
          bridge: {
            status: "KNOWN",
            id: "fleet_bridge",
            version: "0.2.0",
            releaseDigest: "f".repeat(64),
          },
        };
        conflict.configurationId = bridgeDigest(conflict.configuration);
        await repo.save(conflict, at);
        expect(
          (await repo.history(deviceId, 100)).find(
            (r) => r.eventId === conflict.eventId,
          )!.disposition,
        ).toBe("CONFLICT");
        const desired = await app.inject({
          method: "PUT",
          url: `/devices/${deviceId}/bridge-configuration/desired`,
          payload: { revision: 1, configurationId: original.configurationId },
        });
        expect(desired.statusCode).toBe(200);
        expect(desired.json().matchesDesired).toBe(false);
        expect(
          await db
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.targetId, deviceId)),
        ).toHaveLength(1);
        expect(
          (
            await app.inject({
              method: "PUT",
              url: `/devices/${deviceId}/bridge-configuration/desired`,
              payload: {
                revision: 1,
                configurationId: updated.configurationId,
              },
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await app.inject(
              `/devices/${deviceId}/bridge-configuration/reports?limit=0`,
            )
          ).statusCode,
        ).toBe(400);
        expect(
          (await app.inject("/devices/unknown-bridge/bridge-configuration"))
            .statusCode,
        ).toBe(404);
        const unsupported = randomUUID();
        await repo.desired(deviceId, 2, updated.configurationId);
        commandIds.push(unsupported);
        await db.insert(commands).values({
          commandId: unsupported,
          deviceId,
          type: "REBOOT",
          createdAt: at,
        });
        await expect(
          repo.bindExecution(
            unsupported,
            randomUUID(),
            updated.configurationId,
            at,
          ),
        ).rejects.toThrow("CONFIGURATION_UNAVAILABLE");
        expect(
          await db
            .select()
            .from(bridgeReports)
            .where(eq(bridgeReports.eventId, original.eventId)),
        ).toHaveLength(1);
        await expect(
          db
            .update(bridgeConfigurations)
            .set({ snapshot: updated.configuration })
            .where(
              eq(
                bridgeConfigurations.configurationId,
                original.configurationId,
              ),
            ),
        ).rejects.toThrow();
        await expect(
          db
            .update(bridgeCommandConfigurations)
            .set({ configurationId: updated.configurationId })
            .where(eq(bridgeCommandConfigurations.commandId, commandId)),
        ).rejects.toThrow();
      } finally {
        await app.close();
      }
    });
    it("records UNKNOWN separately from unused AI and keeps clock-invalid reports out of current", async () => {
      const repo = createBridgeRepository(database!.db);
      const original = bridgeEventMessageSchema.parse(
        report(bridgeDigest, deviceId),
      );
      const unknown = {
        ...original,
        eventId: randomUUID(),
        sequence: 20,
        reportSequence: 20,
        configurationRevision: 20,
        configuration: {
          ...original.configuration,
          bridge: {
            status: "UNKNOWN" as const,
            reason: "VERSION_UNREPORTED" as const,
          },
        },
      };
      unknown.configurationId = bridgeDigest(unknown.configuration);
      await repo.save(unknown, new Date(unknown.timestamp));
      expect(
        (await repo.get(deviceId))!.reported!.configuration.bridge,
      ).toEqual({ status: "UNKNOWN", reason: "VERSION_UNREPORTED" });
      expect((await repo.get(deviceId))!.reported!.configuration.ai).toEqual({
        status: "NOT_APPLICABLE",
        reason: "NOT_USED",
      });
      const clockInvalid = {
        ...original,
        eventId: randomUUID(),
        sequence: 21,
        reportSequence: 21,
        configurationRevision: 21,
      };
      await repo.save(
        clockInvalid,
        new Date(Date.parse(original.timestamp) + 16000),
      );
      expect(
        (await repo.history(deviceId, 100)).find(
          (r) => r.eventId === clockInvalid.eventId,
        )!.disposition,
      ).toBe("CLOCK_INVALID");
      expect((await repo.get(deviceId))!.reported!.configurationId).toBe(
        unknown.configurationId,
      );
    });
    it("publishes only commit-confirmed scoped receipts and keeps canonical hash stable on resend", async () => {
      const repo = createBridgeRepository(database!.db);
      const original = bridgeEventMessageSchema.parse(
        report(bridgeDigest, deviceId),
      );
      const message = {
        ...original,
        eventId: randomUUID(),
        sequence: 10,
        reportSequence: 10,
        configurationRevision: 10,
      };
      const receipts: unknown[] = [];
      const logger = { warn() {}, error() {} };
      const publish = async (_topic: string, body: string) => {
        expect(
          await database!.db
            .select()
            .from(bridgeReports)
            .where(eq(bridgeReports.eventId, message.eventId)),
        ).toHaveLength(1);
        receipts.push(JSON.parse(body));
      };
      await ingestBridge(
        `fleet/v1/devices/${deviceId}/bridge-events`,
        Buffer.from(JSON.stringify(message)),
        { qos: 1 },
        new Date(message.timestamp),
        repo,
        publish,
        logger,
      );
      await ingestBridge(
        `fleet/v1/devices/${deviceId}/bridge-events`,
        Buffer.from(JSON.stringify(message)),
        { qos: 1 },
        new Date(message.timestamp),
        repo,
        publish,
        logger,
      );
      expect(receipts).toHaveLength(2);
      expect(receipts[0]).toEqual(receipts[1]);
      await ingestBridge(
        "fleet/v1/devices/other/bridge-events",
        Buffer.from(JSON.stringify(message)),
        { qos: 1 },
        new Date(),
        repo,
        publish,
        logger,
      );
      await ingestBridge(
        `fleet/v1/devices/${deviceId}/bridge-events`,
        Buffer.from(
          JSON.stringify({ ...message, configurationId: "0".repeat(64) }),
        ),
        { qos: 1 },
        new Date(),
        repo,
        publish,
        logger,
      );
      expect(receipts).toHaveLength(2);
    });
  },
);
