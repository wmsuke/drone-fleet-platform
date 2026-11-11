// DB/API境界のfixture。実DDSの障害注入とは別に検証する。
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  createBridgeRepository,
  bridgeDigest,
  bridgeHealthEvents,
  devices,
  commands,
  rosObservations,
  rosCommandTargets,
  bridgeCommandConfigurations,
} from "@drone-fleet/database";
import {
  bridgeConfigurationEventSchema,
  bridgeHealthEventSchema,
  rosObservationMessageSchema,
} from "@drone-fleet/protocol";
import { report } from "../../../packages/protocol/test/fixtures/bridge.mjs";
import { healthMessage } from "../../../packages/protocol/test/fixtures/bridge-health.mjs";
import { observation } from "../../../packages/protocol/test/fixtures/ros-observations.mjs";
import { buildApi } from "../../api/src/app.js";
import { createDeviceRepository } from "../../api/src/repository.js";
import { createCommandRepository } from "../../api/src/command-repository.js";
import { createCommandService } from "../../api/src/command-service.js";

const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const ids: string[] = [];
const commandIds: string[] = [];
describe.skipIf(!enabled)(
  "ROS health immutable evidence and stale recovery",
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
        await database!.db
          .delete(rosCommandTargets)
          .where(eq(rosCommandTargets.commandId, id));
        await database!.db.delete(commands).where(eq(commands.commandId, id));
      }
      for (const id of ids) {
        await database!.db
          .delete(bridgeHealthEvents)
          .where(eq(bridgeHealthEvents.deviceId, id));
        await database!.db.delete(devices).where(eq(devices.deviceId, id));
      }
      await database?.client.end();
    });
    async function fixture(currentBridge = false) {
      const repo = createBridgeRepository(database!.db),
        now = new Date();
      const id = `health-${randomUUID().slice(0, 8)}`;
      ids.push(id);
      const source = report(bridgeDigest, id);
      if (currentBridge) {
        source.configuration.bridge.version = "0.5.0";
        source.configuration.adapter.version = "0.4.0";
        source.configurationId = bridgeDigest(source.configuration);
      }
      const config = bridgeConfigurationEventSchema.parse({
        ...source,
        eventId: randomUUID(),
        journalId: randomUUID(),
        timestamp: now.toISOString(),
      });
      await repo.save(config, now);
      const health = bridgeHealthEventSchema.parse({
        ...healthMessage,
        deviceId: id,
        eventId: randomUUID(),
        journalId: config.journalId,
        configurationId: config.configurationId,
        sequence: 2,
        timestamp: now.toISOString(),
      });
      return { repo, now, id, config, health };
    }
    it.each([
      { configFirst: true, sequence: 11 },
      { configFirst: false, sequence: 11 },
      { configFirst: true, sequence: 12 },
    ])(
      "fences health against the latest configuration report: %j",
      async ({ configFirst, sequence }) => {
        const { repo, now, id, config, health } = await fixture(true);
        const ready = bridgeHealthEventSchema.parse({
          ...health,
          sequence,
          ready: true,
          reason: "READY",
          mqttConnected: true,
          mqttSubscribed: true,
          rosAvailable: true,
          observationsFresh: true,
          serverInstanceId: config.configuration.serverInstanceId,
        });
        const newerReport = {
          ...config,
          eventId: randomUUID(),
          sequence: 12,
          reportSequence: 12,
        };
        if (configFirst) await repo.save(newerReport, now);
        expect((await repo.save(ready, now))?.status).toBe("STORED");
        if (!configFirst) {
          expect((await repo.health.get(id, now)).ready).toBe(true);
          await repo.save(newerReport, now);
        }
        expect((await repo.health.history(id, 10))[0]?.disposition).toBe(
          configFirst ? "STALE" : "CURRENT",
        );
        expect(await repo.health.get(id, now)).toMatchObject({
          fresh: false,
          ready: false,
        });
        const quality = {
          ...observation.payload.quality.battery,
          receivedAt: now.toISOString(),
        };
        const sample = rosObservationMessageSchema.parse({
          ...observation,
          deviceId: id,
          timestamp: now.toISOString(),
          payload: {
            ...observation.payload,
            battery: 80,
            flightStatus: "IDLE",
            position: {
              ...observation.payload.position,
              frameId: config.configuration.namespace.slice(1) + "/map",
            },
            quality: {
              ...observation.payload.quality,
              battery: quality,
              position: quality,
              flightStatus: quality,
            },
          },
        });
        await database!.db.insert(rosObservations).values({
          deviceId: id,
          sessionId: sample.sessionId,
          sequence: sample.sequence,
          deviceTimestamp: now,
          receivedAt: now,
          isRetained: false,
          payload: sample.payload,
        });
        await database!.db
          .update(devices)
          .set({ connectionStatus: "ONLINE", lastReceivedAt: now })
          .where(eq(devices.deviceId, id));
        const app = buildApi(
          createDeviceRepository(database!.db),
          createCommandService(
            createCommandRepository(database!.db),
            randomUUID,
            () => now,
          ),
          { bridgeRepository: repo },
        );
        const send = () =>
          app.inject({
            method: "POST",
            url: `/devices/${id}/commands`,
            payload: { type: "RETURN_HOME" },
          });
        try {
          const rejected = await send();
          expect(rejected.statusCode).toBe(409);
          expect(rejected.json().error).toBe("ROS_HEALTH_UNAVAILABLE");
          await repo.save(
            { ...ready, eventId: randomUUID(), sequence: 13 },
            now,
          );
          expect(await repo.health.get(id, now)).toMatchObject({
            fresh: true,
            ready: true,
          });
          const accepted = await send();
          if (accepted.statusCode === 202)
            commandIds.push(accepted.json().commandId);
          expect(accepted.statusCode).toBe(202);
        } finally {
          await app.close();
        }
      },
    );
    it("commits before receipt, deduplicates, and never promotes delayed evidence", async () => {
      const { repo, now, id, health, config } = await fixture();
      const receipt = await repo.save(health, now);
      expect(receipt?.status).toBe("STORED");
      expect(await repo.save(health, new Date(now.getTime() + 1000))).toEqual(
        receipt,
      );
      expect((await repo.health.get(id, now)).ready).toBe(false);
      const ready = bridgeHealthEventSchema.parse({
        ...health,
        eventId: randomUUID(),
        sequence: 4,
        rosAvailable: true,
        observationsFresh: true,
        ready: true,
        serverInstanceId: config.configuration.serverInstanceId,
        reason: "READY" as const,
        mqttConnected: true,
        mqttSubscribed: true,
      });
      await repo.save(ready, now);
      await repo.save({ ...health, eventId: randomUUID(), sequence: 3 }, now);
      expect((await repo.health.get(id, now)).latest?.eventId).toBe(
        ready.eventId,
      );
      expect(
        (await repo.health.get(id, new Date(now.getTime() + 15000))).fresh,
      ).toBe(false);
      await repo.save(
        {
          ...ready,
          eventId: randomUUID(),
          sequence: 5,
          timestamp: new Date(now.getTime() - 16000).toISOString(),
        },
        now,
      );
      expect((await repo.health.get(id, now)).latest?.eventId).toBe(
        ready.eventId,
      );
      expect(
        (await repo.health.history(id, 10)).find(
          (e) => e.message.sequence === 5,
        )?.disposition,
      ).toBe("CLOCK_INVALID");
      await expect(
        database!.db
          .update(bridgeHealthEvents)
          .set({ disposition: "CURRENT" })
          .where(eq(bridgeHealthEvents.eventId, health.eventId)),
      ).rejects.toThrow();
    });
    it("cross-kind IDs cannot overwrite health or make conflicted health ready", async () => {
      const { repo, now, id, health, config } = await fixture();
      await repo.save(health, now);
      expect(
        await repo.save(
          {
            ...config,
            eventId: health.eventId,
            reportSequence: 3,
            sequence: 3,
          },
          now,
        ),
      ).toBeNull();
      expect((await repo.health.get(id, now)).fresh).toBe(false);
      expect(
        await repo.save({ ...health, eventId: config.eventId }, now),
      ).toBeNull();
      expect(await repo.health.history(id, 10)).toHaveLength(1);
    });
    it("exposes bounded history without pretending human work or physical stop", async () => {
      const { repo, now, id, health } = await fixture();
      await repo.save(health, now);
      const app = buildApi(createDeviceRepository(database!.db), undefined, {
        bridgeRepository: repo,
      });
      try {
        const response = await app.inject({
          url: `/devices/${id}/bridge-health?limit=1`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          fresh: true,
          ready: false,
          physicalStopConfirmed: false,
          events: [{ message: { reason: "ROS_UNAVAILABLE" } }],
        });
        expect(
          (await app.inject({ url: `/devices/${id}/bridge-health?limit=0` }))
            .statusCode,
        ).toBe(400);
        expect(
          (
            await app.inject({
              url: "/devices/unknown-health-device/bridge-health",
            })
          ).statusCode,
        ).toBe(404);
      } finally {
        await app.close();
      }
    });
  },
);
