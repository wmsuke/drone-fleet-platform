import { createDatabase, devices, telemetry } from "@drone-fleet/database";
import { telemetryMessageSchema } from "@drone-fleet/protocol";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectAsync } from "mqtt";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { startTelemetryIngestor } from "../src/app.js";
import { createTelemetryRepository } from "../src/repository.js";
import { createDeviceStatusRepository } from "../src/status.js";
import { createCommandAcknowledgementRepository } from "../src/acknowledgement.js";
import { startSimulator } from "../../simulator/src/simulator.js";

const exec = promisify(execFile);
describe.skipIf(process.env.DATABASE_INTEGRATION !== "true")(
  "DB storage receipt path",
  () => {
    it("recovers from ingestor absence, DB connection failure and commit without receipt", async () => {
      const directory = mkdtempSync(join(tmpdir(), "drone-receipt-"));
      const container = `drone-receipt-test-${process.pid}`;
      const database = createDatabase();
      const failedDatabase = createDatabase();
      const deviceId = "integration-receipt-001";
      let simulator: Awaited<ReturnType<typeof startSimulator>> | undefined;
      let ingestor:
        | Awaited<ReturnType<typeof startTelemetryIngestor>>
        | undefined;
      let observer: Awaited<ReturnType<typeof connectAsync>> | undefined;
      let created = false;
      try {
        await migrate(database.db, {
          migrationsFolder: fileURLToPath(
            new URL("../../../packages/database/drizzle", import.meta.url),
          ),
        });
        await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
        await failedDatabase.client.end();
        await exec("docker", [
          "run",
          "-d",
          "--name",
          container,
          "-p",
          "127.0.0.1::1883",
          "-v",
          `${fileURLToPath(new URL("../../../infra/local/mosquitto/config/mosquitto.conf", import.meta.url))}:/mosquitto/config/mosquitto.conf:ro`,
          "eclipse-mosquitto:2.0.22",
        ]);
        created = true;
        const { stdout } = await exec("docker", [
          "port",
          container,
          "1883/tcp",
        ]);
        const port = stdout.trim().split(":").at(-1);
        const url = `mqtt://127.0.0.1:${port}`;
        observer = await connectAsync(url, { connectTimeout: 5000 });
        const received: Array<{ sequence: number; sessionId?: string }> = [];
        observer.on("message", (_topic, payload) => {
          const message = telemetryMessageSchema.parse(
            JSON.parse(payload.toString()),
          );
          received.push({
            sequence: message.sequence,
            ...(message.schemaVersion === 2
              ? { sessionId: message.sessionId }
              : {}),
          });
        });
        await observer.subscribeAsync(
          `fleet/v1/devices/${deviceId}/telemetry`,
          { qos: 1 },
        );
        simulator = await startSimulator({
          deviceId,
          mqttUrl: url,
          simulationSeed: "receipt-test",
          telemetryIntervalMs: 100_000,
          telemetryBufferPath: join(directory, "buffer.sqlite"),
          telemetryBufferMaxRows: 100,
          telemetryBufferMaxBytes: 100_000,
          telemetryPublishTimeoutMs: 150,
          telemetryRetryBaseMs: 100,
          telemetryRetryMaxMs: 200,
          telemetryReplayIntervalMs: 50,
        });
        await vi.waitFor(
          () => expect(received.length).toBeGreaterThanOrEqual(2),
          { timeout: 5000 },
        );
        expect(simulator.getBufferStatus()).toMatchObject({
          rows: 1,
          backlog: 1,
          brokerAcknowledgedUnconfirmed: 1,
        });
        let dbDown = true;
        let dropReceipt = true;
        let dbFailures = 0;
        let duplicates = 0;
        const repository = createTelemetryRepository(database.db);
        const config = {
          mqttTransport: { type: "local" as const, url },
          offlineTimeoutMs: 15_000,
          telemetryBatchSize: 1,
          telemetryFlushIntervalMs: 10,
          telemetryMaxBufferSize: 100,
        };
        const startIngestor = () =>
          startTelemetryIngestor(
            config,
            {
              async saveBatch(entries) {
                if (dbDown) {
                  dbFailures += 1;
                  return createTelemetryRepository(failedDatabase.db).saveBatch(
                    entries,
                  );
                }
                const results = await repository.saveBatch(entries);
                duplicates += results.filter(
                  (value) => value === "duplicate",
                ).length;
                return results;
              },
            },
            createDeviceStatusRepository(database.db),
            createCommandAcknowledgementRepository(database.db),
            { warn: vi.fn(), error: vi.fn() },
            async (mqttUrl, options) => {
              const client = await connectAsync(mqttUrl, options);
              const publish = client.publishAsync.bind(client);
              client.publishAsync = async (...args) =>
                dropReceipt ? undefined : publish(...args);
              return client;
            },
          );
        ingestor = await startIngestor();
        await vi.waitFor(() => expect(dbFailures).toBeGreaterThan(0), {
          timeout: 5000,
        });
        expect(simulator.getBufferStatus().rows).toBe(1);
        dbDown = false;
        await vi.waitFor(
          async () =>
            expect(
              await database.db
                .select()
                .from(telemetry)
                .where(eq(telemetry.deviceId, deviceId)),
            ).toHaveLength(1),
          { timeout: 5000 },
        );
        await ingestor.shutdown();
        ingestor = undefined;
        expect(simulator.getBufferStatus().rows).toBe(1);
        // commit済みだが通知なしで停止した後も同じ行を再送する。
        dropReceipt = false;
        ingestor = await startIngestor();
        await vi.waitFor(
          () => expect(simulator!.getBufferStatus().rows).toBe(0),
          { timeout: 5000 },
        );
        expect(duplicates).toBeGreaterThan(0);
        expect(
          await database.db
            .select()
            .from(telemetry)
            .where(eq(telemetry.deviceId, deviceId)),
        ).toHaveLength(1);
        expect(
          new Set(
            received.map(
              ({ sessionId, sequence }) => `${sessionId}/${sequence}`,
            ),
          ).size,
        ).toBe(1);
      } finally {
        await simulator?.shutdown();
        await ingestor?.shutdown();
        await observer?.endAsync(true);
        await database.db.delete(devices).where(eq(devices.deviceId, deviceId));
        await database.client.end();
        await failedDatabase.client.end();
        if (created) await exec("docker", ["rm", "-fv", container]);
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
