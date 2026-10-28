import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { connectAsync } from "mqtt";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  createDatabase,
  createOtaRepository,
  otaDeploymentLock,
  otaDeviceStates,
  otaAttempts,
  otaTargets,
  otaStages,
  otaDeployments,
  otaOutbox,
  otaQueries,
  otaEvaluations,
  otaEvents,
  commands,
  commandOutbox,
} from "@drone-fleet/database";
import { publishArtifact } from "@drone-fleet/releases";
import {
  otaRequestMessageSchema,
  createOtaRequestsTopic,
} from "@drone-fleet/protocol";
import type { SimulatorMqttClient } from "../../simulator/src/simulator.js";
import { fixture, identity } from "../../ota-supervisor/test/support.js";
import { bootstrap, Supervisor } from "../../ota-supervisor/src/supervisor.js";
import {
  startTelemetryIngestor,
  connectTelemetryClient,
  type RunningTelemetryIngestor,
} from "../../telemetry-ingestor/src/app.js";
import { loadTelemetryIngestorConfig } from "../../telemetry-ingestor/src/config.js";
import { createTelemetryRepository } from "../../telemetry-ingestor/src/repository.js";
import { createDeviceStatusRepository } from "../../telemetry-ingestor/src/status.js";
import { createCommandAcknowledgementRepository } from "../../telemetry-ingestor/src/acknowledgement.js";
import { createOtaMonitor } from "../src/ota-monitor.js";
import { createReleaseRepository } from "../src/release-repository.js";
import { createDeploymentRepository } from "../src/deployment-repository.js";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandService } from "../src/command-service.js";
import { createCommandRepository } from "../src/command-repository.js";

async function until<T>(
  check: () => Promise<T | undefined>,
  timeout = 20000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await setTimeout(250);
  }
  throw new Error("OTA E2E condition timed out");
}
describe.skipIf(process.env.OTA_BACKEND_INTEGRATION !== "true")(
  "real MQTT, PostgreSQL and updated Linux application",
  () => {
    let cleanup: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await cleanup?.();
    });
    it("discovers a real baseline, saves receipts, resumes the backend and evaluates the actual new bundle", async () => {
      const f = await fixture(true),
        database = createDatabase(),
        { db } = database;
      const running: {
        supervisor?: Supervisor;
        app?: ReturnType<typeof buildApi>;
      } = {};
      let completed = false;
      let ingestor: RunningTelemetryIngestor | undefined,
        monitor: ReturnType<typeof createOtaMonitor> | undefined;
      const device = await connectAsync(
        `mqtt://${process.env.MQTT_HOST}:1883`,
        { clientId: "ota-test", clean: true },
      );
      const controller = await connectAsync(
        `mqtt://${process.env.MQTT_HOST}:1883`,
        { clientId: "ota-test-controller", clean: true },
      );
      cleanup = async () => {
        if (!completed)
          console.info(
            "OTA E2E診断",
            JSON.stringify({
              phase: running.supervisor?.journal.read().phase,
              events: (await db.select().from(otaEvents).limit(60)).map(
                (e) => ({
                  sequence: e.sequence.toString(),
                  type: e.payload.type,
                  state: e.payload.state,
                  deviceReason: e.payload.reason,
                  acceptance: e.acceptance,
                  reason: e.reason,
                }),
              ),
              queries: (await db.select().from(otaQueries).limit(20)).map(
                (q) => ({
                  attempts: q.attempts,
                  consumed: q.consumedEventId !== null,
                  challenge: q.challengeId !== null,
                }),
              ),
              evaluations: (
                await db.select().from(otaEvaluations).limit(20)
              ).map((e) => ({ status: e.status, reason: e.reason })),
            }),
          );
        await monitor?.stop();
        await running.supervisor?.close();
        await ingestor?.shutdown();
        await running.app?.close();
        await device.endAsync(true);
        await controller.endAsync(true);
        await database.client.end();
        await new Promise<void>((resolve) => f.server.close(() => resolve()));
        await rm(f.root, { recursive: true, force: true });
      };
      await migrate(db, {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/database/drizzle", import.meta.url),
        ),
      });
      const directory = join(f.root, "artifacts");
      await mkdir(directory);
      for (const envelope of [f.baseline, f.candidate]) {
        await publishArtifact(
          directory,
          f.archives.get(envelope.manifest.digest)!,
        );
        await createReleaseRepository(db).register(envelope);
      }
      let dropFirstReceipt = true,
        droppedEventId: string | undefined;
      const start = async () => {
        ingestor = await startTelemetryIngestor(
          loadTelemetryIngestorConfig(),
          createTelemetryRepository(db),
          createDeviceStatusRepository(db),
          createCommandAcknowledgementRepository(db),
          console,
          async (url, options) => {
            const client = await connectTelemetryClient(url, options),
              publish = client.publishAsync.bind(client);
            client.publishAsync = async (topic, payload, opts) => {
              const receipt = JSON.parse(payload);
              if (
                dropFirstReceipt &&
                topic.endsWith("/ota-receipts") &&
                receipt.type !== "INVENTORY"
              ) {
                dropFirstReceipt = false;
                droppedEventId = receipt.eventId;
                return;
              }
              return publish(topic, payload, opts);
            };
            return client;
          },
          undefined,
          undefined,
          createOtaRepository(db),
        );
        monitor = createOtaMonitor(db, async (topic, payload, expires) => {
          if (Date.now() >= expires.getTime()) throw new Error("query expired");
          await controller.publishAsync(topic, payload, {
            qos: 1,
            retain: false,
          });
        });
        monitor.start();
      };
      await start();
      await bootstrap(f.config, identity(f.baseline));
      const supervisor = new Supervisor(
        f.config,
        device as unknown as SimulatorMqttClient,
      );
      running.supervisor = supervisor;
      await supervisor.start();
      const observed = await until(async () => {
        const [state] = await db
          .select()
          .from(otaDeviceStates)
          .where(eq(otaDeviceStates.deviceId, "ota-test"));
        return state?.snapshot.releaseId === f.baseline.manifest.releaseId
          ? state
          : undefined;
      });
      expect(observed.snapshot.bootId).toBeTypeOf("string");
      // 通常commandで帰還完了を確認してから予約する。飛行中を更新可能へ補完しない。
      const home = await createCommandService(createCommandRepository(db)).send(
        "ota-test",
        "RETURN_HOME",
      );
      const [homeOutbox] = await db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.commandId, home.commandId));
      await controller.publishAsync(homeOutbox!.topic, homeOutbox!.payload, {
        qos: 1,
        retain: false,
      });
      await until(async () => {
        const [command] = await db
          .select()
          .from(commands)
          .where(eq(commands.commandId, home.commandId));
        return command?.executionStatus === "SUCCEEDED" ? true : undefined;
      });
      const app = buildApi(
        createDeviceRepository(db),
        createCommandService(createCommandRepository(db)),
        {
          deploymentRepository: createDeploymentRepository(db, {
            directory,
            trustStorePath: f.config.trustPath,
          }),
        },
      );
      running.app = app;
      const response = await app.inject({
        method: "POST",
        url: "/deployments",
        headers: { "Idempotency-Key": "ota-e2e" },
        payload: {
          releaseId: f.candidate.manifest.releaseId,
          deviceIds: ["ota-test"],
        },
      });
      expect(response.statusCode).toBe(202);
      const accepted = response.json();
      const [target] = await db
        .select()
        .from(otaTargets)
        .where(eq(otaTargets.deploymentId, accepted.deploymentId));
      const [attempt] = await db
        .select()
        .from(otaAttempts)
        .where(eq(otaAttempts.targetId, target!.targetId));
      const created = new Date(),
        expiresAt = new Date(created.getTime() + 300000),
        resultDeadline = new Date(created.getTime() + 600000);
      const apply = otaRequestMessageSchema.parse({
        schemaVersion: 1,
        deviceId: "ota-test",
        deploymentId: accepted.deploymentId,
        stageId: target!.stageId,
        targetId: target!.targetId,
        attemptId: attempt!.attemptId,
        commandId: attempt!.commandId,
        fence: attempt!.fence.toString(),
        release: identity(f.candidate),
        type: "APPLY_RELEASE",
        purpose: "APPLY",
        createdAt: created.toISOString(),
        expiresAt: expiresAt.toISOString(),
        resultDeadline: resultDeadline.toISOString(),
        evaluationVersion: "ota-health-v1",
      });
      // #171の未実装APIを通したとはしない。解禁済みsnapshotをfixtureで準備する。
      await db.transaction(async (tx) => {
        await otaDeploymentLock(tx, accepted.deploymentId);
        await tx
          .update(otaStages)
          .set({ status: "RUNNING" })
          .where(eq(otaStages.stageId, target!.stageId));
        await tx
          .update(otaDeployments)
          .set({ status: "RUNNING" })
          .where(eq(otaDeployments.deploymentId, accepted.deploymentId));
        await tx
          .update(otaAttempts)
          .set({
            startedAt: created,
            expiresAt,
            resultDeadline,
            deliveryStatus: "PENDING",
          })
          .where(eq(otaAttempts.attemptId, attempt!.attemptId));
        await tx
          .update(otaOutbox)
          .set({
            status: "PENDING",
            payload: JSON.stringify(apply),
            expiresAt,
            nextAttemptAt: created,
          })
          .where(eq(otaOutbox.commandId, attempt!.commandId));
      });
      await controller.publishAsync(
        createOtaRequestsTopic("ota-test"),
        JSON.stringify(apply),
        { qos: 1, retain: false },
      );
      await until(async () => {
        const [count] = await db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM ota_queries WHERE attempt_id=${attempt!.attemptId} AND consumed_event_id IS NOT NULL AND challenge_id IS NOT NULL`,
        );
        return count!.count >= 5 ? true : undefined;
      }, 60000);
      expect(
        (
          await db
            .select()
            .from(otaAttempts)
            .where(eq(otaAttempts.attemptId, attempt!.attemptId))
        )[0]!.evaluationStatus,
      ).not.toBe("SUCCEEDED");
      await monitor!.stop();
      await ingestor!.shutdown();
      await start();
      await until(async () => {
        const [current] = await db
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.attemptId, attempt!.attemptId));
        if (
          current?.evaluationStatus === "FAILED" ||
          current?.evaluationStatus === "UNCERTAIN"
        )
          throw new Error(`evaluation ${current.evaluationStatus}`);
        return current?.evaluationStatus === "SUCCEEDED" ? true : undefined;
      }, 110000);
      expect(supervisor.journal.read().active.manifest.digest).toBe(
        f.candidate.manifest.digest,
      );
      const detail = (
        await app.inject({ url: `/deployments/${accepted.deploymentId}` })
      ).json();
      expect(detail.targets[0].current.releaseId).toBe(
        f.candidate.manifest.releaseId,
      );
      expect(detail.targets[0].current.bootId).not.toBe(
        observed.snapshot.bootId,
      );
      expect(detail.targets[0].attempts[0].freshHealth).toBe(true);
      const evaluations = await db
        .select()
        .from(otaEvaluations)
        .where(eq(otaEvaluations.attemptId, attempt!.attemptId));
      expect(
        evaluations.find((e) => e.status === "SUCCEEDED")!.evidence.length,
      ).toBeGreaterThan(13);
      expect(dropFirstReceipt).toBe(false);
      expect(
        await db
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, droppedEventId!)),
      ).toHaveLength(1);
      expect(
        (
          await db
            .select()
            .from(otaQueries)
            .where(eq(otaQueries.attemptId, attempt!.attemptId))
        ).filter((q) => q.consumedEventId !== null && q.challengeId !== null)
          .length,
      ).toBeGreaterThanOrEqual(13);
      completed = true;
    }, 180000);
  },
);
