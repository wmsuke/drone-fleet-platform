import { describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connectAsync, type IClientPublishOptions } from "mqtt";
import { eq, inArray, desc } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  createDatabase,
  createOtaRepository,
  otaDeviceStates,
  otaInventories,
  otaTargets,
  otaAttempts,
  otaOutbox,
  otaEvents,
  otaEvaluations,
  otaRecoveries,
  otaInterventions,
  otaReservations,
  commands,
  commandOutbox,
} from "@drone-fleet/database";
import { publishArtifact } from "@drone-fleet/releases";
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
import { createDeploymentRecovery } from "../src/deployment-control.js";
import { createReleaseRepository } from "../src/release-repository.js";
import { createDeploymentRepository } from "../src/deployment-repository.js";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandService } from "../src/command-service.js";
import { createCommandRepository } from "../src/command-repository.js";

async function until(
  check: () => Promise<boolean>,
  label: string,
  timeout = 30000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`OTA fleet timeout: ${label}`);
}

// 実時間の60秒healthと本番workerの2 slot / 1 claim毎秒を短縮しない。
describe.skipIf(process.env.OTA_FLEET_INTEGRATION !== "true")(
  "ten real Linux applications over MQTT and PostgreSQL",
  () => {
    it.each([
      "staged-success",
      "canary-health-rollback",
      "rollback-failed",
      "rollback-unavailable",
      "missing-reports",
    ] as const)(
      "%s",
      async (scenario) => {
        const startedAt = new Date();
        const f = await fixture(true, [
          `${["staged-success", "canary-health-rollback", "rollback-failed", "rollback-unavailable", "missing-reports"].indexOf(scenario) + 1}.0.0`,
          `${["staged-success", "canary-health-rollback", "rollback-failed", "rollback-unavailable", "missing-reports"].indexOf(scenario) + 1}.1.0`,
        ]);
        const database = createDatabase(),
          { db } = database;
        const ids = Array.from(
          { length: 10 },
          (_, i) => `${scenario}-${String(i).padStart(2, "0")}`,
        );
        const clients: Awaited<ReturnType<typeof connectAsync>>[] = [];
        const supervisors: Supervisor[] = [];
        const monitors: ReturnType<typeof createOtaMonitor>[] = [];
        const sent: { at: string; payload: Record<string, unknown> }[] = [];
        const stageTimes: {
          position: number;
          approvedAt: string;
          passedAt?: string;
        }[] = [];
        const initialBoots = new Map<string, string>();
        const homeIds: string[] = [];
        const wireEvents = new Map<string, number>();
        const wireReceipts = new Map<string, number>();
        const localCommands: { commandId: string; status?: string }[] = [];
        let deploymentId: string | undefined,
          ingestor: RunningTelemetryIngestor | undefined;
        let app: ReturnType<typeof buildApi> | undefined;
        let blockReceipts = false,
          passed = false;
        let blockReports = false;
        const controller = await connectAsync(
          `mqtt://${process.env.MQTT_HOST}:1883`,
          { clientId: `${scenario}-controller` },
        );
        controller.on("message", (topic, bytes) => {
          const value = JSON.parse(bytes.toString());
          if (topic.endsWith("/command-acks")) {
            const command = localCommands.find(
              (c) => c.commandId === value.commandId,
            );
            if (command) command.status = value.status;
            return;
          }
          if (!ids.includes(value.deviceId) || !value.eventId) return;
          const counts = topic.endsWith("/ota-events")
            ? wireEvents
            : wireReceipts;
          counts.set(value.eventId, (counts.get(value.eventId) ?? 0) + 1);
        });
        const directory = join(f.root, "artifacts");
        const options = { directory, trustStorePath: f.config.trustPath };
        const publish = async (
          topic: string,
          payload: string,
          expires: Date,
        ) => {
          if (Date.now() >= expires.getTime())
            throw new Error("expired publish");
          sent.push({
            at: new Date().toISOString(),
            payload: JSON.parse(payload),
          });
          await controller.publishAsync(topic, payload, {
            qos: 1,
            retain: false,
          });
        };
        async function startWorkers() {
          // 独立monitorが同じDBのclaim/排他を共有する。
          for (let i = 0; i < 2; i++) {
            const monitor = createOtaMonitor(
              db,
              publish,
              createOtaRepository(db),
              createDeploymentRecovery(db, options),
            );
            monitors.push(monitor);
            monitor.start();
          }
        }
        async function stopWorkers() {
          await Promise.all(monitors.splice(0).map((m) => m.stop()));
        }
        async function detail() {
          const response = await app!.inject({
            url: `/deployments/${deploymentId}?eventLimit=100`,
          });
          expect(response.statusCode).toBe(200);
          return response.json();
        }
        async function post(
          path: string,
          key: string,
          payload: Record<string, unknown>,
        ) {
          return app!.inject({
            method: "POST",
            url: `/deployments/${deploymentId}${path}`,
            headers: { "Idempotency-Key": key },
            payload,
          });
        }
        try {
          await controller.subscribeAsync(
            [
              "fleet/v1/devices/+/ota-events",
              "fleet/v1/devices/+/ota-receipts",
              "fleet/v1/devices/+/command-acks",
            ],
            { qos: 1 },
          );
          await migrate(db, {
            migrationsFolder: fileURLToPath(
              new URL("../../../packages/database/drizzle", import.meta.url),
            ),
          });
          await mkdir(directory);
          for (const envelope of [f.baseline, f.candidate]) {
            await publishArtifact(
              directory,
              f.archives.get(envelope.manifest.digest)!,
            );
            await createReleaseRepository(db).register(envelope);
          }
          ingestor = await startTelemetryIngestor(
            loadTelemetryIngestorConfig(),
            createTelemetryRepository(db),
            createDeviceStatusRepository(db),
            createCommandAcknowledgementRepository(db),
            console,
            async (url, config) => {
              const client = await connectTelemetryClient(url, config),
                original = client.publishAsync.bind(client);
              client.publishAsync = async (topic, payload, opts) => {
                if (
                  blockReceipts &&
                  topic === `fleet/v1/devices/${ids[0]}/telemetry-receipts`
                )
                  return;
                return original(topic, payload, opts);
              };
              return client;
            },
            undefined,
            undefined,
            createOtaRepository(db),
          );
          app = buildApi(
            createDeviceRepository(db),
            createCommandService(createCommandRepository(db)),
            { deploymentRepository: createDeploymentRepository(db, options) },
          );
          await startWorkers();
          for (const deviceId of ids) {
            const config = {
              ...f.config,
              deviceId,
              root: join(f.root, deviceId, "state"),
              data: join(f.root, deviceId, "data"),
            };
            await mkdir(join(f.root, deviceId), { mode: 0o755 });
            const client = await connectAsync(
              `mqtt://${process.env.MQTT_HOST}:1883`,
              { clientId: deviceId },
            );
            clients.push(client);
            const originalPublish = client.publishAsync.bind(client);
            client.publishAsync = async (
              topic,
              payload,
              opts?: IClientPublishOptions,
            ) => {
              if (
                blockReports &&
                deviceId === ids[0] &&
                topic.endsWith("/ota-events")
              )
                return undefined;
              return originalPublish(topic, payload, opts);
            };
            await bootstrap(config, identity(f.baseline));
            const supervisor = new Supervisor(
              config,
              client as unknown as SimulatorMqttClient,
            );
            supervisors.push(supervisor);
            await supervisor.start();
            await until(
              async () =>
                (
                  await db
                    .select()
                    .from(otaDeviceStates)
                    .where(eq(otaDeviceStates.deviceId, deviceId))
                ).length === 1,
              `${deviceId} discovered`,
            );
            const home = await createCommandService(
              createCommandRepository(db),
            ).send(deviceId, "RETURN_HOME");
            homeIds.push(home.commandId);
            const [outbox] = await db
              .select()
              .from(commandOutbox)
              .where(eq(commandOutbox.commandId, home.commandId));
            await controller.publishAsync(outbox!.topic, outbox!.payload, {
              qos: 1,
              retain: false,
            });
            initialBoots.set(
              deviceId,
              (await supervisor.child.inspect("HEALTH", "0")).bootId,
            );
          }
          await until(async () => {
            const results = await db
              .select()
              .from(commands)
              .where(inArray(commands.commandId, homeIds));
            return (
              results.length === 10 &&
              results.every((c) => c.executionStatus === "SUCCEEDED")
            );
          }, "ten home results");
          await until(
            async () =>
              (
                await db
                  .select()
                  .from(otaDeviceStates)
                  .where(inArray(otaDeviceStates.deviceId, ids))
              ).length === 10,
            "inventory",
          );
          const response = await app.inject({
            method: "POST",
            url: "/deployments",
            headers: { "Idempotency-Key": scenario },
            payload: {
              releaseId: f.candidate.manifest.releaseId,
              deviceIds: ids,
            },
          });
          expect(response.statusCode, response.body).toBe(202);
          const accepted = response.json();
          deploymentId = accepted.deploymentId;
          expect(
            accepted.stages.map(
              (s: { deviceIds: string[] }) => s.deviceIds.length,
            ),
          ).toEqual([1, 3, 6]);
          for (const stage of accepted.stages) {
            if (scenario !== "staged-success" && stage.position > 0) break;
            const approval = await post(
              `/stages/${stage.stageId}/approve`,
              `approve-${stage.position}`,
              { reason: "LOCAL_E2E" },
            );
            expect(approval.statusCode, approval.body).toBe(202);
            stageTimes.push({
              position: stage.position,
              approvedAt: new Date().toISOString(),
            });
            console.info(
              "OTA_FLEET_STAGE",
              scenario,
              stage.position,
              "approved",
            );
            if (scenario !== "staged-success") {
              await until(
                async () =>
                  supervisors[0]!.journal.read().active.manifest.digest ===
                  f.candidate.manifest.digest,
                "candidate boot",
              );
              if (scenario !== "missing-reports") {
                // 起動直後のreceipt未到着と、稼働後の経路断を混ぜない。
                await until(async () => {
                  if (
                    supervisors[0]!.journal.read().phase !== "HEALTH_CHECKING"
                  )
                    return false;
                  return (
                    (await supervisors[0]!.child.inspect("HEALTH", "1"))
                      .receipts > 0
                  );
                }, "candidate received telemetry receipt");
              }
              if (scenario === "missing-reports") blockReports = true;
              else blockReceipts = true;
              break;
            }
            if (stage.position === 0) {
              await until(
                async () =>
                  (
                    await db
                      .select()
                      .from(otaEvents)
                      .where(
                        inArray(
                          otaEvents.attemptId,
                          (
                            await db
                              .select()
                              .from(otaAttempts)
                              .where(
                                inArray(
                                  otaAttempts.targetId,
                                  (
                                    await db
                                      .select()
                                      .from(otaTargets)
                                      .where(eq(otaTargets.deviceId, ids[0]!))
                                  ).map((t) => t.targetId),
                                ),
                              )
                          ).map((a) => a.attemptId),
                        ),
                      )
                  ).filter((e) => e.payload.type === "HEALTH").length >= 5,
                "five health samples",
                60000,
              );
              expect((await detail()).status).not.toBe("COMPLETED");
              await stopWorkers();
              await ingestor.shutdown();
              ingestor = await startTelemetryIngestor(
                loadTelemetryIngestorConfig(),
                createTelemetryRepository(db),
                createDeviceStatusRepository(db),
                createCommandAcknowledgementRepository(db),
                console,
                undefined,
                undefined,
                undefined,
                createOtaRepository(db),
              );
              await startWorkers();
            }
            await until(
              async () =>
                (await detail()).stages[stage.position].status === "PASSED",
              `stage ${stage.position}`,
              280000,
            );
            stageTimes.at(-1)!.passedAt = new Date().toISOString();
            console.info("OTA_FLEET_STAGE", scenario, stage.position, "passed");
            const state = await detail();
            for (const later of accepted.stages.slice(stage.position + 1)) {
              for (const id of later.deviceIds) {
                expect(
                  supervisors[ids.indexOf(id)]!.journal.read().active.manifest
                    .digest,
                ).toBe(f.baseline.manifest.digest);
                expect(
                  sent.filter(
                    (s) =>
                      s.payload.deviceId === id &&
                      s.payload.type === "APPLY_RELEASE",
                  ),
                ).toHaveLength(0);
              }
            }
            expect(
              state.targets.filter(
                (t: { status: string }) => t.status === "SUCCEEDED",
              ).length,
            ).toBe(
              accepted.stages
                .slice(0, stage.position + 1)
                .reduce(
                  (n: number, s: { deviceIds: string[] }) =>
                    n + s.deviceIds.length,
                  0,
                ),
            );
          }
          if (scenario === "staged-success") {
            await until(
              async () => (await detail()).status === "COMPLETED",
              "completed",
            );
            for (const [i, supervisor] of supervisors.entries()) {
              const observed = await supervisor.child.inspect("HEALTH", "1");
              expect(observed.behavior).toBe("updated");
              expect(observed.bootId).not.toBe(initialBoots.get(ids[i]!));
              expect(
                supervisor.journal.events().filter((e) => e.type === "VERSION"),
              ).toHaveLength(1);
            }
            expect(
              await db
                .select()
                .from(otaReservations)
                .where(inArray(otaReservations.deviceId, ids)),
            ).toHaveLength(0);
          } else if (scenario === "missing-reports") {
            const responses = await Promise.all([
              post("/stop", "stop-without-reports", {
                reason: "REPORT_PATH_LOST",
              }),
              post("/stop", "stop-without-reports", {
                reason: "REPORT_PATH_LOST",
              }),
            ]);
            expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
            expect(responses[0]!.json()).toEqual(responses[1]!.json());
            await until(
              async () => (await detail()).status === "WAITING_FOR_HUMAN",
              "unconfirmed stop handoff",
              90000,
            );
            expect(
              sent.filter(
                (s) =>
                  s.payload.type === "APPLY_RELEASE" &&
                  s.payload.deviceId !== ids[0],
              ),
            ).toHaveLength(0);
            expect(
              await db
                .select()
                .from(otaReservations)
                .where(inArray(otaReservations.deviceId, ids)),
            ).toHaveLength(10);
            const state = await detail();
            expect(
              state.targets.find(
                (t: { deviceId: string }) => t.deviceId === ids[0],
              ).attempts[0].evaluationStatus,
            ).not.toBe("SUCCEEDED");
            const review = await post("/interventions", "handoff", {
              reason: "STOP_UNCONFIRMED",
            });
            expect(review.statusCode).toBe(202);
            expect(
              (
                await post(
                  `/interventions/${review.json().interventionId}/complete`,
                  "handoff-complete",
                  {
                    reason: "MANUAL_INSPECTION_REQUIRED",
                    outcome: "ESCALATED",
                  },
                )
              ).statusCode,
            ).toBe(202);
            const before = [...wireEvents.values()].reduce(
              (n, count) => n + count,
              0,
            );
            blockReports = false;
            await until(
              async () =>
                [...wireEvents.values()].reduce((n, count) => n + count, 0) >
                before,
              "reports restored",
            );
            expect((await detail()).status).toBe("WAITING_FOR_HUMAN");
            for (const supervisor of supervisors.slice(1))
              expect(supervisor.journal.read().active.manifest.digest).toBe(
                f.baseline.manifest.digest,
              );
          } else {
            await until(
              async () => (await detail()).status === "PAUSED",
              "failed canary paused",
              90000,
            );
            blockReceipts = false;
            const state = await detail(),
              target = state.targets.find(
                (t: { deviceId: string }) => t.deviceId === ids[0],
              );
            expect(target.attempts[0].evaluationStatus).toBe("FAILED");
            expect(
              sent.filter(
                (s) =>
                  s.payload.type === "APPLY_RELEASE" &&
                  s.payload.deviceId !== ids[0],
              ),
            ).toHaveLength(0);
            // receipt復旧後の新しい実観測だけで許可を取り直す。同keyで拒否を上書きしない。
            await until(async () => {
              const [row] = await db
                .select()
                .from(otaInventories)
                .where(eq(otaInventories.deviceId, ids[0]!))
                .orderBy(desc(otaInventories.sequence))
                .limit(1);
              return (
                (row?.payload.readiness as Record<string, string> | undefined)
                  ?.receipts === "PASSED" &&
                (row?.receivedAt.getTime() ?? 0) > Date.now() - 5000
              );
            }, "restored receipts");
            // 新版の仮想飛行を止める端末側作業。予約を回避するHTTP APIは追加しない。
            // この人間介入を記録し、rollbackの自律成功へ読み替えない。
            const review = await post("/interventions", "handoff", {
              reason: "PREPARE_LOCAL_RECOVERY",
            });
            expect(review.statusCode, review.body).toBe(202);
            const commandId = randomUUID(),
              timestamp = Date.now();
            localCommands.push({ commandId });
            await controller.publishAsync(
              `fleet/v1/devices/${ids[0]}/commands`,
              JSON.stringify({
                schemaVersion: 2,
                deviceId: ids[0],
                commandId,
                type: "RETURN_HOME",
                timestamp: new Date(timestamp).toISOString(),
                expiresAt: new Date(timestamp + 30000).toISOString(),
              }),
              { qos: 1, retain: false },
            );
            await until(
              async () => localCommands.at(-1)?.status === "SUCCEEDED",
              "local return home",
            );
            if (scenario === "rollback-unavailable")
              await writeFile(f.config.trustPath, JSON.stringify({ keys: [] }));
            const recovery = await post(
              `/targets/${target.targetId}/recover`,
              "rollback",
              { kind: "ROLLBACK", reason: "CANARY_HEALTH_FAILED" },
            );
            expect(recovery.statusCode, recovery.body).toBe(
              scenario === "rollback-unavailable" ? 409 : 202,
            );
            const replay = await post(
              `/targets/${target.targetId}/recover`,
              "rollback",
              { kind: "ROLLBACK", reason: "CANARY_HEALTH_FAILED" },
            );
            expect(replay.json()).toEqual(recovery.json());
            if (scenario === "rollback-failed") {
              await until(
                async () =>
                  supervisors[0]!.journal.read().active.manifest.digest ===
                  f.baseline.manifest.digest,
                "rollback boot",
              );
              await until(async () => {
                if (supervisors[0]!.journal.read().phase !== "HEALTH_CHECKING")
                  return false;
                return (
                  (await supervisors[0]!.child.inspect("HEALTH", "2"))
                    .receipts > 0
                );
              }, "rollback received telemetry receipt");
              blockReceipts = true;
            }
            await until(
              async () =>
                (await detail()).recoveries.some(
                  (r: { status: string }) =>
                    r.status ===
                    (scenario === "rollback-failed"
                      ? "FAILED"
                      : scenario === "rollback-unavailable"
                        ? "UNAVAILABLE"
                        : "SUCCEEDED"),
                ),
              "rollback evaluated",
              120000,
            );
            const recovered = await detail();
            expect(recovered.status).toBe("WAITING_FOR_HUMAN");
            expect(
              recovered.targets.find(
                (t: { deviceId: string }) => t.deviceId === ids[0],
              ).status,
            ).toBe(
              scenario === "canary-health-rollback"
                ? "RECOVERED"
                : "FAILED",
            );
            expect(
              (
                await supervisors[0]!.child.inspect(
                  "HEALTH",
                  scenario === "rollback-unavailable" ? "1" : "2",
                )
              ).behavior,
            ).toBe(
              scenario === "rollback-unavailable" ? "updated" : "baseline",
            );
            if (scenario !== "canary-health-rollback")
              expect(recovered.recoveries[0].requiredAction).toBe(
                "INSPECT_BACKUP_OR_REPLACE_DEVICE",
              );
            // 旧attemptの遅着/重複は回復結果や新bootを巻き戻さない。
            const oldEvent = (
              await db
                .select()
                .from(otaEvents)
                .where(eq(otaEvents.attemptId, target.attempts[0].attemptId))
            )[0]!;
            const beforeReceipts = wireReceipts.get(oldEvent.eventId) ?? 0;
            for (let i = 0; i < 3; i++)
              await controller.publishAsync(
                `fleet/v1/devices/${ids[0]}/ota-events`,
                JSON.stringify(oldEvent.payload),
                { qos: 1, retain: false },
              );
            await until(
              async () =>
                (wireReceipts.get(oldEvent.eventId) ?? 0) >= beforeReceipts + 3,
              "duplicate receipts",
            );
            const afterLate = await detail();
            expect(afterLate.status).toBe("WAITING_FOR_HUMAN");
            const beforeTarget = recovered.targets.find(
              (t: { deviceId: string }) => t.deviceId === ids[0],
            );
            const afterTarget = afterLate.targets.find(
              (t: { deviceId: string }) => t.deviceId === ids[0],
            );
            expect(afterTarget.status).toBe(beforeTarget.status);
            expect(afterTarget.current.bootId).toBe(
              beforeTarget.current.bootId,
            );
            expect(
              await db
                .select()
                .from(otaEvents)
                .where(eq(otaEvents.eventId, oldEvent.eventId)),
            ).toHaveLength(1);
            expect(
              await db
                .select()
                .from(otaReservations)
                .where(inArray(otaReservations.deviceId, ids)),
            ).toHaveLength(10);
            for (const supervisor of supervisors.slice(1))
              expect(supervisor.journal.read().active.manifest.digest).toBe(
                f.baseline.manifest.digest,
              );
            const end = await post(
              `/interventions/${review.json().interventionId}/complete`,
              "handoff-complete",
              { reason: "KEEP_RESERVATIONS", outcome: "KEEP_STOPPED" },
            );
            expect(end.statusCode, end.body).toBe(202);
            expect((await detail()).status).toBe("WAITING_FOR_HUMAN");
          }
          const interventions = await db
            .select()
            .from(otaInterventions)
            .where(eq(otaInterventions.deploymentId, deploymentId!));
          expect(interventions).toHaveLength(3);
          expect(
            interventions.filter((i) => i.category === "REQUIRED_APPROVAL"),
          ).toHaveLength(scenario === "staged-success" ? 3 : 1);
          expect(
            interventions.filter((i) => i.category === "FAULT_RESPONSE"),
          ).toHaveLength(scenario === "staged-success" ? 0 : 2);
          passed = true;
        } finally {
          try {
            await stopWorkers();
            if (deploymentId) {
              const targets = await db
                .select()
                .from(otaTargets)
                .where(eq(otaTargets.deploymentId, deploymentId));
              const attempts = await db
                .select()
                .from(otaAttempts)
                .where(
                  inArray(
                    otaAttempts.targetId,
                    targets.map((t) => t.targetId),
                  ),
                );
              const events = await db
                .select()
                .from(otaEvents)
                .where(
                  inArray(
                    otaEvents.attemptId,
                    attempts.map((a) => a.attemptId),
                  ),
                );
              console.info(
                "OTA_FLEET_REPORT",
                JSON.stringify(
                  {
                    scenario,
                    passed,
                    startedAt,
                    finishedAt: new Date(),
                    deploymentId,
                    targetCount: targets.length,
                    runtime: {
                      platform: process.platform,
                      arch: process.arch,
                      node: process.version,
                      workers: 2,
                      telemetryIntervalMs: f.config.telemetryIntervalMs,
                    },
                    localCommands,
                    deviceJournals: supervisors.map((supervisor, i) => {
                      const state = supervisor.journal.read();
                      return {
                        deviceId: ids[i],
                        phase: state.phase,
                        active: identity(state.active),
                        budget: state.apply
                          ? supervisor.journal.budget(state.apply.targetId)
                          : null,
                      };
                    }),
                    stageTimes,
                    sent: sent.map((s) => ({
                      at: s.at,
                      type: s.payload.type,
                      commandId: s.payload.commandId,
                      attemptId: s.payload.attemptId,
                    })),
                    targets,
                    attempts,
                    outbox: await db
                      .select()
                      .from(otaOutbox)
                      .where(
                        inArray(
                          otaOutbox.commandId,
                          attempts.map((a) => a.commandId),
                        ),
                      ),
                    receivedEvents: events.length,
                    eventSummary: events.map((e) => ({
                      eventId: e.eventId,
                      attemptId: e.attemptId,
                      acceptance: e.acceptance,
                      type: e.payload.type,
                      state: e.payload.state,
                      reason: e.payload.reason,
                      checks: e.payload.checks,
                    })),
                    mqttEventDeliveries: [...wireEvents.values()].reduce(
                      (n, count) => n + count,
                      0,
                    ),
                    mqttReceiptDeliveries: [...wireReceipts.values()].reduce(
                      (n, count) => n + count,
                      0,
                    ),
                    evaluations: await db
                      .select()
                      .from(otaEvaluations)
                      .where(
                        inArray(
                          otaEvaluations.attemptId,
                          attempts.map((a) => a.attemptId),
                        ),
                      ),
                    recoveries: await db
                      .select()
                      .from(otaRecoveries)
                      .where(eq(otaRecoveries.deploymentId, deploymentId)),
                    interventions: await db
                      .select()
                      .from(otaInterventions)
                      .where(eq(otaInterventions.deploymentId, deploymentId)),
                    cost: null,
                  },
                  (_, value) =>
                    typeof value === "bigint" ? value.toString() : value,
                ),
              );
            } else {
              console.info(
                "OTA_FLEET_REPORT",
                JSON.stringify({
                  scenario,
                  passed: false,
                  phase: "SETUP",
                  startedAt,
                  finishedAt: new Date(),
                  commands: await db
                    .select()
                    .from(commands)
                    .where(inArray(commands.deviceId, ids))
                    .catch(() => []),
                }),
              );
            }
          } finally {
            const children = await Promise.allSettled(
              supervisors.map((s) => s.close()),
            );
            const resources = await Promise.allSettled([
              ingestor?.shutdown(),
              app?.close(),
              ...clients.map((c) => c.endAsync(true)),
              controller.endAsync(true),
              database.client.end(),
              new Promise<void>((resolve) => f.server.close(() => resolve())),
            ]);
            await rm(f.root, { recursive: true, force: true });
            const failures = [...children, ...resources].filter(
              (r) => r.status === "rejected",
            );
            expect(failures, "OTA fixture cleanup failed").toEqual([]);
          }
        }
      },
      660000,
    );
  },
);
