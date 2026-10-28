import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, inArray, sql } from "drizzle-orm";
import {
  createDatabase,
  devices,
  groups,
  groupMemberships,
  releases,
  auditLogs,
  otaDeviceStates,
  otaDeployments,
  otaStages,
  otaTargets,
  otaReservations,
  otaAttempts,
  otaOutbox,
  otaEvents,
  otaActions,
  otaRollouts,
  otaDispatches,
  otaStops,
  otaQueries,
  otaEvaluations,
  otaInventories,
  createOtaRollout,
  createOtaRepository,
  commands,
} from "@drone-fleet/database";
import {
  canonical,
  packBundle,
  digestOf,
  publishArtifact,
  type Envelope,
} from "@drone-fleet/releases";
import { createDeploymentRepository } from "../src/deployment-repository.js";
import {
  otaRequestMessageSchema,
  otaEventMessageSchema,
} from "@drone-fleet/protocol";
import {
  deploymentRequestSchema,
  deploymentResponseSchema,
} from "../src/deployment-schema.js";
import { createCommandRepository } from "../src/command-repository.js";
import { createFleetOperationRepository } from "../src/fleet-operation-repository.js";
import { createGroupRepository } from "../src/group-repository.js";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandService } from "../src/command-service.js";

const enabled = process.env.DATABASE_INTEGRATION === "true";
describe.skipIf(!enabled)("deployment acceptance with PostgreSQL", () => {
  const database = enabled ? createDatabase() : undefined;
  const db = database?.db;
  const ids = Array.from(
    { length: 101 },
    (_, n) => `issue169-${String(n).padStart(3, "0")}`,
  );
  const groupIds: string[] = [];
  let root: string, trustStorePath: string, old: Envelope, next: Envelope;
  const pair = generateKeyPairSync("ed25519");
  function repository() {
    return createDeploymentRepository(db!, { directory: root, trustStorePath });
  }
  function request(extra: Record<string, unknown> = {}) {
    return deploymentRequestSchema.parse({
      releaseId: next.manifest.releaseId,
      deviceIds: ids.slice(0, 10),
      ...extra,
    });
  }
  async function release(version: string) {
    const bytes = packBundle(
      Buffer.from(`console.info(${JSON.stringify(version)});`),
    );
    const manifest = {
      schemaVersion: 1 as const,
      releaseId: randomUUID(),
      application: "simulator" as const,
      version,
      buildId: "issue169",
      platform: "linux-arm64" as const,
      nodeRange: ">=22.13.0 <23",
      otaProtocolRange: "^1.0.0",
      supervisorRange: "^1.0.0",
      stateSchemaRange: "1.0.0",
      digest: digestOf(bytes),
      size: bytes.length,
      entrypoint: "app/main.mjs" as const,
      healthContractVersion: "ota-health-v1" as const,
      rollbackCompatible: true,
    };
    const envelope: Envelope = {
      manifest,
      keyId: "test",
      algorithm: "Ed25519",
      signature: sign(
        null,
        Buffer.from(canonical(manifest)),
        pair.privateKey,
      ).toString("base64"),
    };
    await publishArtifact(root, bytes);
    await db!.insert(releases).values({ ...manifest, envelope });
    return envelope;
  }
  async function group(members: string[]) {
    const groupId = randomUUID();
    groupIds.push(groupId);
    await db!.insert(groups).values({ groupId, name: "OTA試験" });
    if (members.length)
      await db!
        .insert(groupMemberships)
        .values(members.map((deviceId) => ({ groupId, deviceId })));
    return groupId;
  }
  async function cleanup() {
    const targets = await db!
      .select()
      .from(otaTargets)
      .where(inArray(otaTargets.deviceId, ids));
    const deployments = [...new Set(targets.map((t) => t.deploymentId))];
    if (deployments.length) {
      const attempts = await db!
        .select()
        .from(otaAttempts)
        .where(
          inArray(
            otaAttempts.targetId,
            targets.map((t) => t.targetId),
          ),
        );
      for (const table of [otaDispatches, otaStops, otaQueries, otaEvaluations])
        await db!.delete(table).where(
          inArray(
            table.attemptId,
            attempts.map((a) => a.attemptId),
          ),
        );
      await db!
        .delete(otaActions)
        .where(inArray(otaActions.deploymentId, deployments));
      await db!
        .delete(otaRollouts)
        .where(inArray(otaRollouts.deploymentId, deployments));
      await db!.delete(otaEvents).where(
        inArray(
          otaEvents.attemptId,
          attempts.map((a) => a.attemptId),
        ),
      );
      await db!.delete(otaOutbox).where(
        inArray(
          otaOutbox.commandId,
          attempts.map((a) => a.commandId),
        ),
      );
      await db!.delete(otaAttempts).where(
        inArray(
          otaAttempts.targetId,
          targets.map((t) => t.targetId),
        ),
      );
      await db!
        .delete(otaReservations)
        .where(inArray(otaReservations.deviceId, ids));
      await db!
        .delete(otaTargets)
        .where(inArray(otaTargets.deploymentId, deployments));
      await db!
        .delete(otaStages)
        .where(inArray(otaStages.deploymentId, deployments));
      await db!
        .delete(otaDeployments)
        .where(inArray(otaDeployments.deploymentId, deployments));
    }
    await db!
      .delete(otaInventories)
      .where(inArray(otaInventories.deviceId, ids));
    await db!
      .delete(otaDeviceStates)
      .where(inArray(otaDeviceStates.deviceId, ids));
    if (groupIds.length) {
      await db!
        .delete(groupMemberships)
        .where(inArray(groupMemberships.groupId, groupIds));
      await db!
        .delete(groups)
        .where(inArray(groups.groupId, groupIds.splice(0)));
    }
    await db!.delete(commands).where(inArray(commands.deviceId, ids));
    await db!.delete(devices).where(inArray(devices.deviceId, ids));
  }
  beforeAll(async () => {
    await migrate(db!, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    root = await realpath(await mkdtemp(join(tmpdir(), "issue169-")));
    trustStorePath = join(root, "trust.json");
    await writeFile(
      trustStorePath,
      JSON.stringify({
        keys: [
          {
            keyId: "test",
            publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
            revoked: false,
          },
        ],
      }),
    );
    const suffix = randomUUID();
    old = await release(`0.1.0-test.${suffix}`);
    next = await release(`0.2.0-test.${suffix}`);
  });
  beforeEach(async () => {
    await cleanup();
    await db!.insert(devices).values(ids.map((deviceId) => ({ deviceId })));
    await db!.insert(otaDeviceStates).values(
      ids.map((deviceId) => ({
        deviceId,
        observedAt: new Date(),
        snapshot: {
          application: "simulator",
          platform: "linux-arm64",
          nodeVersion: "22.13.0",
          otaProtocolVersion: "1.0.0",
          supervisorVersion: "1.0.0",
          stateSchemaVersion: "1.0.0",
          releaseId: old.manifest.releaseId,
          version: old.manifest.version,
          digest: old.manifest.digest,
          buildId: old.manifest.buildId,
          bootId: randomUUID(),
          healthContractVersion: "ota-health-v1",
        },
      })),
    );
  });
  afterAll(async () => {
    if (database) {
      await cleanup();
      await database.client.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  // 段階制御は既存の証拠評価を入力として検証する。60秒評価自体はOTA evidence testで検証する。
  async function ready() {
    const states = await db!
      .select()
      .from(otaDeviceStates)
      .where(inArray(otaDeviceStates.deviceId, ids));
    const readiness = {
      eventLoop: "PASSED",
      telemetry: "PASSED",
      sqlite: "PASSED",
      commandReady: "PASSED",
      mqtt: "PASSED",
      subscriptions: "PASSED",
      receipts: "PASSED",
    };
    const now = new Date();
    await db!.insert(otaInventories).values(
      states.map((s) => ({
        eventId: randomUUID(),
        deviceId: s.deviceId,
        sequence: 0n,
        reason: "ACCEPTED",
        payloadHash: "a".repeat(64),
        payload: {
          schemaVersion: 1,
          type: "INVENTORY",
          deviceId: s.deviceId,
          eventId: randomUUID(),
          sequence: 0,
          supervisorBootId: randomUUID(),
          timestamp: now.toISOString(),
          measuredAt: now.toISOString(),
          sampleAgeMs: 0,
          readiness,
          running: {
            release: {
              releaseId: s.snapshot.releaseId,
              digest: s.snapshot.digest,
              version: s.snapshot.version,
              buildId: s.snapshot.buildId,
            },
            bootId: s.snapshot.bootId,
          },
          capabilities: Object.fromEntries(
            Object.entries(s.snapshot).filter(
              ([k]) =>
                ![
                  "releaseId",
                  "digest",
                  "version",
                  "buildId",
                  "bootId",
                ].includes(k),
            ),
          ),
        },
        receipt: {},
        receivedAt: now,
      })),
    );
  }
  async function stageSuccess(id: string, stageId: string, now: Date) {
    const detail = await repository().find(id, 20, stageId);
    for (const target of detail!.targets) {
      const a = target.attempts[0]!;
      const bootId = randomUUID(),
        supervisorBootId = randomUUID();
      const release = {
        releaseId: next.manifest.releaseId,
        version: next.manifest.version,
        buildId: next.manifest.buildId,
        digest: next.manifest.digest,
      };
      const scope = {
        schemaVersion: 1,
        deviceId: target.deviceId,
        deploymentId: id,
        stageId,
        targetId: target.targetId,
        attemptId: a.attemptId,
        fence: a.fence,
        release,
        applyCommandId: a.commandId,
        supervisorBootId,
        timestamp: now.toISOString(),
      };
      for (const [sequence, extra] of [
        { type: "VERSION", running: { release, bootId } },
        {
          type: "HEALTH",
          running: { release, bootId },
          queryCommandId: randomUUID(),
          challengeId: randomUUID(),
          measuredAt: now.toISOString(),
          sampleMonotonicMs: 1,
          sampleAgeMs: 0,
          checks: {
            eventLoop: "PASSED",
            telemetry: "PASSED",
            sqlite: "PASSED",
            commandReady: "PASSED",
            mqtt: "PASSED",
            subscriptions: "PASSED",
            receipts: "PASSED",
          },
        },
      ].entries()) {
        const eventId = randomUUID();
        await db!.insert(otaEvents).values({
          eventId,
          attemptId: a.attemptId,
          sequence: BigInt(sequence),
          payloadHash: "a".repeat(64),
          payload: { ...scope, ...extra, sequence, eventId },
          occurredAt: now,
          receivedAt: now,
          storedAt: now,
          acceptance: "ACCEPTED",
        });
      }
      const [state] = await db!
        .select()
        .from(otaDeviceStates)
        .where(eq(otaDeviceStates.deviceId, target.deviceId));
      await db!
        .update(otaDeviceStates)
        .set({
          snapshot: { ...state!.snapshot, ...release, bootId },
          observedAt: now,
        })
        .where(eq(otaDeviceStates.deviceId, target.deviceId));
      await db!
        .update(otaAttempts)
        .set({
          evaluationStatus: "SUCCEEDED",
          applicationStatus: "APPLIED",
          deliveryStatus: "ACKNOWLEDGED",
        })
        .where(eq(otaAttempts.attemptId, a.attemptId));
      await db!
        .update(otaOutbox)
        .set({ status: "ACKNOWLEDGED" })
        .where(eq(otaOutbox.commandId, a.commandId));
      await db!
        .update(otaTargets)
        .set({ status: "SUCCEEDED" })
        .where(eq(otaTargets.targetId, target.targetId));
    }
  }
  it("requires reasoned approval and all fixed targets with current health before promotion", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    const rollout = createOtaRollout(db!);
    expect(await rollout.tick()).toEqual([]);
    await expect(
      repo.act(
        d.deploymentId,
        "approve",
        randomUUID(),
        "DEMO",
        d.stages[1]!.stageId,
      ),
    ).rejects.toMatchObject({ reason: "STAGE_NOT_READY" });
    const key = randomUUID(),
      first = d.stages[0]!.stageId;
    const responses = await Promise.all([
      repo.act(d.deploymentId, "approve", key, "DEMO", first),
      repo.act(d.deploymentId, "approve", key, "DEMO", first),
    ]);
    expect(responses[0]).toEqual(responses[1]);
    await expect(
      repo.act(d.deploymentId, "stop", key, "DEMO"),
    ).rejects.toMatchObject({ reason: "IDEMPOTENCY_CONFLICT" });
    expect(await rollout.tick()).toHaveLength(1);
    await stageSuccess(d.deploymentId, first, new Date());
    await rollout.tick();
    const detail = await repo.find(d.deploymentId, 20);
    expect(detail!.stages.map((s) => s.status)).toEqual([
      "PASSED",
      "AWAITING_APPROVAL",
      "PENDING",
    ]);
    expect(
      detail!.targets
        .filter((t) => t.stageId !== first)
        .every((t) => t.attempts[0]!.deliveryStatus === "HELD"),
    ).toBe(true);
    // 新しいbootのINVENTORYが届いたら、過去のSUCCEEDEDで解禁しない。
    const [state] = await db!
      .select()
      .from(otaDeviceStates)
      .where(eq(otaDeviceStates.deviceId, ids[0]!));
    await db!
      .update(otaDeviceStates)
      .set({ snapshot: { ...state!.snapshot, bootId: randomUUID() } })
      .where(eq(otaDeviceStates.deviceId, ids[0]!));
    await expect(
      repo.act(
        d.deploymentId,
        "approve",
        randomUUID(),
        "DEMO",
        d.stages[1]!.stageId,
      ),
    ).rejects.toMatchObject({ reason: "PREVIOUS_STAGE_UNCONFIRMED" });
  });
  it("persists a global concurrency limit of two and one claim per second across workers", async () => {
    let now = new Date();
    const rollout = createOtaRollout(db!, { clock: () => now });
    const input = request({
      deviceIds: ids.slice(0, 4),
      stages: [{ deviceIds: ids.slice(0, 4) }],
    });
    const d = await repository().create(input, randomUUID());
    await repository().act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    now = new Date();
    const sends = (await Promise.all([rollout.tick(), rollout.tick()])).flat();
    expect(sends).toHaveLength(1);
    // PUBACKがなくてもclaimは再起動後に残る。同じpayloadを上限内で再送する。
    now = new Date(now.getTime() + 1000);
    const second = await rollout.tick();
    expect(second).toHaveLength(1);
    expect(second[0]!.commandId).not.toBe(sends[0]!.commandId);
    for (const send of [...sends, ...second])
      await db!
        .update(otaOutbox)
        .set({ status: "ACKNOWLEDGED" })
        .where(eq(otaOutbox.commandId, send.commandId));
    now = new Date(now.getTime() + 1000);
    expect(await createOtaRollout(db!, { clock: () => now }).tick()).toEqual(
      [],
    );
  });
  it("latches at the inclusive 10 percent boundary with the original denominator", async () => {
    const d = await repository().create(
      request({ stages: [{ deviceIds: ids.slice(0, 10) }] }),
      randomUUID(),
    );
    await repository().act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    const detail = await repository().find(d.deploymentId, 20),
      a = detail!.targets[0]!.attempts[0]!;
    await db!
      .update(otaAttempts)
      .set({ evaluationStatus: "FAILED" })
      .where(eq(otaAttempts.attemptId, a.attemptId));
    expect(await createOtaRollout(db!).tick()).toEqual([]);
    let after = await repository().find(d.deploymentId, 20);
    expect(after!.control!.stopReason).toBe("FAILURE_THRESHOLD");
    expect(after!.stages[0]!.denominator).toBe(10);
    await db!
      .update(otaAttempts)
      .set({ evaluationStatus: "SUCCEEDED" })
      .where(eq(otaAttempts.attemptId, a.attemptId));
    expect(await createOtaRollout(db!).tick()).toEqual([]);
    after = await repository().find(d.deploymentId, 20);
    expect(after!.control!.stoppedAt).not.toBeNull();
    expect(after!.status).not.toBe("COMPLETED");
  });
  it("suppresses a claimed apply after stop and never interprets stop acceptance as stopped", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    let now = new Date();
    const worker = createOtaRollout(db!, { clock: () => now });
    const [send] = await worker.tick();
    const stopped = await repo.act(
      d.deploymentId,
      "stop",
      randomUUID(),
      "OPERATOR_STOP",
    );
    expect(stopped.status).toBe("STOPPING");
    let published = 0;
    await worker.deliver(send!, async () => {
      published++;
    });
    expect(published).toBe(0);
    const stops = await worker.tick();
    expect(stops).toHaveLength(1);
    expect(JSON.parse(stops[0]!.payload).type).toBe("STOP_UPDATE");
    await expect(
      repo.act(d.deploymentId, "resume", randomUUID(), "RESUME"),
    ).rejects.toMatchObject({ reason: "STOP_UNCONFIRMED" });
    now = new Date(now.getTime() + 61000);
    await worker.tick();
    const detail = await repo.find(d.deploymentId, 20);
    expect(detail!.status).toBe("WAITING_FOR_HUMAN");
    expect(detail!.targets[0]!.attempts[0]!.stop!.confirmedEventId).toBeNull();
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(eq(otaReservations.deviceId, ids[0]!)),
    ).toHaveLength(1);
  });
  it("serializes a stop with a publisher already inside the deployment lock", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    const worker = createOtaRollout(db!);
    const [send] = await worker.tick();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      barrier = new Promise<void>((r) => {
        release = r;
      });
    const delivery = worker.deliver(send!, async () => {
      enter();
      await barrier;
    });
    await entered;
    let finished = false;
    const stop = repo
      .act(d.deploymentId, "stop", randomUUID(), "OPERATOR_STOP")
      .then(() => {
        finished = true;
      });
    await setTimeout(30);
    expect(finished).toBe(false);
    release();
    await Promise.all([delivery, stop]);
    expect((await repo.find(d.deploymentId, 20))!.status).toBe("STOPPING");
  });
  it("resumes only unsent work without changing payload, fences or deadlines", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    const approved = await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    const before = await db!.select().from(otaOutbox);
    const key = randomUUID();
    expect(
      await repo.act(d.deploymentId, "stop", key, "OPERATOR_STOP"),
    ).toEqual(await repo.act(d.deploymentId, "stop", key, "OPERATOR_STOP"));
    await createOtaRollout(db!).tick();
    expect((await repo.find(d.deploymentId, 20))!.status).toBe("PAUSED");
    await expect(
      repo.act(d.deploymentId, "resume", randomUUID(), "RESUME"),
    ).rejects.toMatchObject({ reason: "HEALTH_UNCONFIRMED" });
    await ready();
    expect(
      (await repo.act(d.deploymentId, "resume", randomUUID(), "RESUME")).status,
    ).toBe("RUNNING");
    const after = await db!.select().from(otaOutbox);
    expect(after).toEqual(before);
    expect(approved.status).toBe("RUNNING");
  });
  it("revalidates revoked releases before resume and rejects invalid HTTP action bodies", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    const app = buildApi(
      createDeviceRepository(db!),
      createCommandService(createCommandRepository(db!)),
      { deploymentRepository: repo },
    );
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/deployments/${d.deploymentId}/stop`,
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
      await repo.act(d.deploymentId, "stop", randomUUID(), "OPERATOR_STOP");
      await createOtaRollout(db!).tick();
      const original = await import("node:fs/promises").then((fs) =>
        fs.readFile(trustStorePath, "utf8"),
      );
      try {
        await writeFile(trustStorePath, JSON.stringify({ keys: [] }));
        await expect(
          repo.act(d.deploymentId, "resume", randomUUID(), "RESUME"),
        ).rejects.toMatchObject({ reason: "RELEASE_OR_DEVICE_UNAVAILABLE" });
      } finally {
        await writeFile(trustStorePath, original);
      }
    } finally {
      await app.close();
    }
  });

  it("does not stop below ten percent but stops immediately for one uncertain target", async () => {
    const repo = repository();
    const selected = ids.slice(0, 100);
    const d = await repo.create(
      request({ deviceIds: selected, stages: [{ deviceIds: selected }] }),
      randomUUID(),
    );
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    const detail = await repo.find(d.deploymentId, 1);
    for (const target of detail!.targets.slice(0, 9))
      await db!
        .update(otaAttempts)
        .set({ evaluationStatus: "FAILED" })
        .where(eq(otaAttempts.attemptId, target.attempts[0]!.attemptId));
    const worker = createOtaRollout(db!);
    await worker.tick();
    expect((await repo.find(d.deploymentId, 1))!.control).toBeNull();
    await db!
      .update(otaAttempts)
      .set({ evaluationStatus: "UNCERTAIN" })
      .where(
        eq(otaAttempts.attemptId, detail!.targets[9]!.attempts[0]!.attemptId),
      );
    const sends = await worker.tick();
    expect(sends.every((s) => s.stop)).toBe(true);
    expect((await repo.find(d.deploymentId, 1))!.control!.stopReason).toBe(
      "UNCERTAIN",
    );
  }, 20000);
  it("expires unacknowledged starts without inventing stopped or extending deadlines", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    const before = await repo.find(d.deploymentId, 1),
      deadline = before!.targets[0]!.attempts[0]!.expiresAt!;
    const worker = createOtaRollout(db!, { clock: () => new Date(deadline) });
    expect(await worker.tick()).toEqual([]);
    const after = await repo.find(d.deploymentId, 1);
    expect(after!.control!.stopReason).toBe("FAILURE_THRESHOLD");
    expect(after!.targets[0]!.attempts[0]!.deliveryStatus).toBe("EXPIRED");
    expect(after!.targets[0]!.attempts[0]!.applicationStatus).toBeNull();
    expect(after!.targets[0]!.attempts[0]!.expiresAt).toBe(deadline);
    await expect(
      createOtaRollout(db!, { clock: () => new Date(deadline) }).act(
        d.deploymentId,
        "resume",
        randomUUID(),
        "RESUME",
      ),
    ).rejects.toMatchObject({ reason: "DEVICE_OTA_UNCONFIRMED" });
  });
  it("requires both matching STOPPED and fresh STATE; keeps the applied version and reservation", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    const worker = createOtaRollout(db!);
    await worker.tick();
    await repo.act(d.deploymentId, "stop", randomUUID(), "OPERATOR_STOP");
    const [send] = await worker.tick();
    const stop = otaRequestMessageSchema.parse(JSON.parse(send!.payload));
    expect(stop.type).toBe("STOP_UPDATE");
    const now = new Date(),
      receiver = createOtaRepository(db!, { clock: () => now });
    const base = {
      schemaVersion: 1,
      deviceId: stop.deviceId,
      deploymentId: stop.deploymentId,
      stageId: stop.stageId,
      targetId: stop.targetId,
      attemptId: stop.attemptId,
      fence: stop.fence,
      release: stop.release,
      applyCommandId: (stop as { applyCommandId: string }).applyCommandId,
      supervisorBootId: randomUUID(),
      timestamp: now.toISOString(),
    };
    const wrong = otaEventMessageSchema.parse({
      ...base,
      type: "PROGRESS",
      eventId: randomUUID(),
      sequence: 0,
      requestType: "STOP_UPDATE",
      state: "STOPPED",
      commandId: randomUUID(),
      reason: null,
      downloadedBytes: 0,
    });
    await receiver.ingest(wrong, now);
    expect(
      (await repo.find(d.deploymentId, 5))!.targets[0]!.attempts[0]!.stop!
        .confirmedEventId,
    ).toBeNull();
    await receiver.ingest(
      otaEventMessageSchema.parse({
        ...wrong,
        eventId: randomUUID(),
        sequence: 1,
        commandId: stop.commandId,
      }),
      now,
    );
    await worker.tick();
    expect((await repo.find(d.deploymentId, 5))!.status).toBe("STOPPING");
    const queryId = randomUUID(),
      expiresAt = new Date(now.getTime() + 15000);
    const query = otaRequestMessageSchema.parse({
      ...stop,
      type: "QUERY_STATE",
      commandId: queryId,
      challengeId: null,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      resultDeadline: expiresAt.toISOString(),
    });
    await db!.insert(otaQueries).values({
      commandId: queryId,
      attemptId: stop.attemptId,
      payload: query,
      createdAt: now,
      expiresAt,
      nextAttemptAt: expiresAt,
      attempts: 1,
    });
    const state = otaEventMessageSchema.parse({
      ...base,
      eventId: randomUUID(),
      sequence: 2,
      type: "STATE",
      queryCommandId: queryId,
      state: "STOPPED",
      running: {
        release: {
          releaseId: old.manifest.releaseId,
          digest: old.manifest.digest,
          version: old.manifest.version,
          buildId: old.manifest.buildId,
        },
        bootId: randomUUID(),
      },
    });
    await receiver.ingest(state, now);
    await worker.tick();
    const after = await repo.find(d.deploymentId, 5);
    expect(after!.status).toBe("PAUSED");
    expect(after!.targets[0]!.attempts[0]!.stop!.confirmedEventId).toBe(
      state.eventId,
    );
    expect(after!.targets[0]!.current!.releaseId).toBe(old.manifest.releaseId);
    expect(after!.targets[0]!.attempts[0]!.evaluationStatus).not.toBe(
      "SUCCEEDED",
    );
    await expect(
      repo.act(d.deploymentId, "resume", randomUUID(), "RESUME"),
    ).rejects.toMatchObject({ reason: "NEW_ATTEMPT_REQUIRED" });
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(eq(otaReservations.deviceId, stop.deviceId)),
    ).toHaveLength(1);
  });
  it("completes only all targets and releases reservations atomically without rollback", async () => {
    const repo = repository(),
      d = await repo.create(
        request({ deviceIds: ids.slice(0, 1) }),
        randomUUID(),
      );
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    await stageSuccess(d.deploymentId, d.stages[0]!.stageId, new Date());
    await createOtaRollout(db!).tick();
    const detail = await repo.find(d.deploymentId, 5);
    expect(detail!.status).toBe("COMPLETED");
    expect(detail!.targets[0]!.current!.releaseId).toBe(
      next.manifest.releaseId,
    );
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(eq(otaReservations.deviceId, ids[0]!)),
    ).toHaveLength(0);
  });
  it("does not release a next stage when approval races with stop", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    await stageSuccess(d.deploymentId, d.stages[0]!.stageId, new Date());
    const worker = createOtaRollout(db!);
    await worker.tick();
    const results = await Promise.allSettled([
      repo.act(
        d.deploymentId,
        "approve",
        randomUUID(),
        "DEMO",
        d.stages[1]!.stageId,
      ),
      repo.act(d.deploymentId, "stop", randomUUID(), "OPERATOR_STOP"),
    ]);
    expect(results[1]!.status).toBe("fulfilled");
    expect((await worker.tick()).every((s) => s.stop)).toBe(true);
    expect(
      (await repo.find(d.deploymentId, 5))!.control!.stoppedAt,
    ).not.toBeNull();
  });
  it("serializes resume and concurrent workers without duplicate new applications", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    await repo.act(d.deploymentId, "stop", randomUUID(), "OPERATOR_STOP");
    const worker = createOtaRollout(db!);
    await worker.tick();
    await ready();
    const results = await Promise.all([
      repo.act(d.deploymentId, "resume", randomUUID(), "RESUME"),
      worker.tick(),
      worker.tick(),
    ]);
    expect(results[0].status).toBe("RUNNING");
    const later = await worker.tick();
    expect([...results[1], ...results[2], ...later]).toHaveLength(1);
    const dispatches = await db!.select().from(otaDispatches);
    expect(dispatches).toHaveLength(1);
  });
  it("bounds retries across restart and never changes the apply payload", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    await repo.act(
      d.deploymentId,
      "approve",
      randomUUID(),
      "DEMO",
      d.stages[0]!.stageId,
    );
    let now = new Date();
    const sends = [];
    for (let n = 0; n < 5; n++) {
      sends.push(...(await createOtaRollout(db!, { clock: () => now }).tick()));
      now = new Date(now.getTime() + 8000);
    }
    expect(sends).toHaveLength(5);
    expect(new Set(sends.map((s) => s.commandId)).size).toBe(1);
    expect(new Set(sends.map((s) => s.payload)).size).toBe(1);
    expect(await createOtaRollout(db!, { clock: () => now }).tick()).toEqual(
      [],
    );
  });
  it("rolls back approval, issued deadlines and action when audit cannot be saved", async () => {
    const repo = repository(),
      d = await repo.create(request(), randomUUID());
    await db!.execute(
      sql`CREATE FUNCTION issue171_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='deployment.approved' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`,
    );
    await db!.execute(
      sql`CREATE TRIGGER issue171_reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION issue171_reject_audit()`,
    );
    try {
      await expect(
        repo.act(
          d.deploymentId,
          "approve",
          randomUUID(),
          "DEMO",
          d.stages[0]!.stageId,
        ),
      ).rejects.toThrow();
      const detail = await repo.find(d.deploymentId, 5);
      expect(detail!.stages[0]!.status).toBe("AWAITING_APPROVAL");
      expect(detail!.targets[0]!.attempts[0]!.startedAt).toBeNull();
      expect(detail!.actions).toEqual([]);
    } finally {
      await db!.execute(sql`DROP TRIGGER issue171_reject_audit ON audit_logs`);
      await db!.execute(sql`DROP FUNCTION issue171_reject_audit()`);
    }
  });

  it("snapshots groups, stages, release, policy and held attempts atomically; replay never re-resolves membership", async () => {
    const groupId = await group(ids.slice(0, 10));
    const input = request({ deviceIds: [], groupIds: [groupId] });
    const key = randomUUID();
    const app = buildApi(
      createDeviceRepository(db!),
      createCommandService(createCommandRepository(db!)),
      { deploymentRepository: repository(), auditDatabase: db! },
    );
    let result;
    try {
      const accepted = await app.inject({
        method: "POST",
        url: "/deployments",
        headers: { "Idempotency-Key": key },
        payload: input,
      });
      expect(accepted.statusCode).toBe(202);
      result = deploymentResponseSchema.parse(accepted.json());
    } finally {
      await app.close();
    }
    expect(result.status).toBe("ACCEPTED");
    expect(result.stages.map((s) => s.deviceIds.length)).toEqual([1, 3, 6]);
    expect(result.stages.map((s) => s.status)).toEqual([
      "AWAITING_APPROVAL",
      "PENDING",
      "PENDING",
    ]);
    expect(result.policy.maxConcurrentApplications).toBe(2);
    await createGroupRepository(db!).removeMember(groupId, ids[0]!);
    await createGroupRepository(db!).addMember(groupId, ids[10]!);
    await db!
      .delete(otaDeviceStates)
      .where(eq(otaDeviceStates.deviceId, ids[0]!));
    expect(await repository().create(input, key)).toEqual(result);
    const targets = await db!
      .select()
      .from(otaTargets)
      .where(eq(otaTargets.deploymentId, result.deploymentId));
    expect(targets.map((t) => t.deviceId).sort()).toEqual(ids.slice(0, 10));
    const attempts = await db!
      .select()
      .from(otaAttempts)
      .where(
        inArray(
          otaAttempts.targetId,
          targets.map((t) => t.targetId),
        ),
      );
    expect(attempts).toHaveLength(10);
    for (const a of attempts)
      expect(a).toMatchObject({
        fence: 1n,
        startedAt: null,
        expiresAt: null,
        resultDeadline: null,
        deliveryStatus: "HELD",
        applicationStatus: null,
        evaluationStatus: "PENDING",
      });
    const waiting = await db!
      .select()
      .from(otaOutbox)
      .where(
        inArray(
          otaOutbox.commandId,
          attempts.map((a) => a.commandId),
        ),
      );
    expect(waiting).toHaveLength(10);
    expect(
      waiting.every(
        (o) => o.status === "HELD" && o.payload === null && o.attempts === 0,
      ),
    ).toBe(true);
    const audit = await db!
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, result.deploymentId));
    expect(audit.map((a) => a.action).sort()).toEqual([
      "deployment.accepted",
      "deployment.replayed",
    ]);
    await expect(
      db!
        .update(otaDeployments)
        .set({ policy: { successRate: 0 } })
        .where(eq(otaDeployments.deploymentId, result.deploymentId)),
    ).rejects.toThrow();
    await expect(
      db!
        .update(otaStages)
        .set({ deviceIds: [ids[100]!] })
        .where(eq(otaStages.stageId, result.stages[0]!.stageId)),
    ).rejects.toThrow();
    await expect(
      db!
        .update(otaTargets)
        .set({ snapshot: {} })
        .where(eq(otaTargets.targetId, targets[0]!.targetId)),
    ).rejects.toThrow();
    await expect(
      db!
        .update(otaAttempts)
        .set({ fence: 2n })
        .where(eq(otaAttempts.attemptId, attempts[0]!.attemptId)),
    ).rejects.toThrow();
    await expect(
      db!
        .update(releases)
        .set({ version: "9.9.9" })
        .where(eq(releases.releaseId, next.manifest.releaseId)),
    ).rejects.toThrow();
    await expect(
      repository().create(request({ deviceIds: [ids[0]!] }), key),
    ).rejects.toMatchObject({ reason: "IDEMPOTENCY_CONFLICT" });
  });
  it("same-key parallel requests create exactly one deployment and attempt set", async () => {
    const key = randomUUID(),
      input = request({ deviceIds: [ids[0]!] });
    const [a, b] = await Promise.all([
      repository().create(input, key),
      repository().create(input, key),
    ]);
    expect(a).toEqual(b);
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(eq(otaReservations.deviceId, ids[0]!)),
    ).toHaveLength(1);
  });
  it("accepts 100 targets with an explicit immutable stage configuration", async () => {
    const input = request({
      deviceIds: ids.slice(0, 100),
      stages: [
        { deviceIds: ids.slice(0, 2) },
        { deviceIds: ids.slice(2, 100) },
      ],
    });
    const result = await repository().create(input, randomUUID());
    expect(result.targetCount).toBe(100);
    expect(result.stages.map((s) => s.deviceIds.length)).toEqual([2, 98]);
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(inArray(otaReservations.deviceId, ids)),
    ).toHaveLength(100);
  });
  it("different keys competing for one device never create two deployments", async () => {
    const input = request({ deviceIds: [ids[0]!] });
    const results = await Promise.allSettled([
      repository().create(input, randomUUID()),
      repository().create(input, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db!
        .select()
        .from(otaTargets)
        .where(eq(otaTargets.deviceId, ids[0]!)),
    ).toHaveLength(1);
  });
  it("reserves all stages; rejects another deployment and ordinary single/fleet commands", async () => {
    await repository().create(request(), randomUUID());
    const app = buildApi(
      createDeviceRepository(db!),
      createCommandService(createCommandRepository(db!)),
    );
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/devices/${ids[9]}/commands`,
            payload: { type: "REBOOT" },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
    const groupId = await group([ids[9]!, ids[10]!]);
    await expect(
      createFleetOperationRepository(db!).create(
        { groupId, type: "REBOOT" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ reason: "DEVICE_RESERVED_FOR_OTA" });
    expect(
      await db!.select().from(commands).where(inArray(commands.deviceId, ids)),
    ).toHaveLength(0);
    await setTimeout(1050);
    await expect(
      repository().create(request(), randomUUID()),
    ).rejects.toMatchObject({ reason: "DEVICE_RESERVED" });
  });
  it("rate-limits new requests across repository instances without throttling replay", async () => {
    const input = request({ deviceIds: [ids[0]!] }),
      key = randomUUID();
    const accepted = await repository().create(input, key);
    await expect(
      repository().create(request({ deviceIds: [ids[1]!] }), randomUUID()),
    ).rejects.toMatchObject({ status: 429 });
    expect(await repository().create(input, key)).toEqual(accepted);
  });
  it("rejects empty, overlapping, oversized, missing and non-OTA targets without partial writes", async () => {
    const empty = await group([]),
      overlap = await group([ids[0]!]),
      tooMany = await group(ids);
    for (const [input, reason] of [
      [request({ deviceIds: [], groupIds: [empty] }), "EMPTY_TARGETS"],
      [
        request({ deviceIds: [ids[0]!], groupIds: [overlap] }),
        "DUPLICATE_TARGETS",
      ],
      [
        request({ deviceIds: [], groupIds: [tooMany] }),
        "TARGET_LIMIT_EXCEEDED",
      ],
      [request({ deviceIds: ["unknown"] }), "DEVICE_NOT_FOUND"],
      [request({ stages: [{ deviceIds: [ids[0]!] }] }), "INVALID_STAGES"],
    ] as const)
      await expect(
        repository().create(input, randomUUID()),
      ).rejects.toMatchObject({ reason });
    await db!
      .delete(otaDeviceStates)
      .where(eq(otaDeviceStates.deviceId, ids[0]!));
    await expect(
      repository().create(request(), randomUUID()),
    ).rejects.toMatchObject({ reason: "DEVICE_OTA_UNCONFIRMED" });
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(inArray(otaReservations.deviceId, ids)),
    ).toHaveLength(0);
  });
  it("rejects stale capability, incompatible runtime/platform, and revoked signing keys", async () => {
    const [original] = await db!
      .select()
      .from(otaDeviceStates)
      .where(eq(otaDeviceStates.deviceId, ids[0]!));
    await db!
      .update(otaDeviceStates)
      .set({ observedAt: new Date(Date.now() - 15000) })
      .where(eq(otaDeviceStates.deviceId, ids[0]!));
    await expect(
      repository().create(request(), randomUUID()),
    ).rejects.toMatchObject({ reason: "DEVICE_OTA_UNCONFIRMED" });
    for (const patch of [
      { nodeVersion: "24.0.0" },
      { platform: "linux-x64" },
    ]) {
      await db!
        .update(otaDeviceStates)
        .set({
          observedAt: new Date(),
          snapshot: { ...original!.snapshot, ...patch },
        })
        .where(eq(otaDeviceStates.deviceId, ids[0]!));
      await expect(
        repository().create(request(), randomUUID()),
      ).rejects.toMatchObject({ reason: "INCOMPATIBLE_DEVICE" });
    }
    await writeFile(trustStorePath, JSON.stringify({ keys: [] }));
    await expect(
      repository().create(request(), randomUUID()),
    ).rejects.toMatchObject({ reason: "RELEASE_UNAVAILABLE" });
    await writeFile(
      trustStorePath,
      JSON.stringify({
        keys: [
          {
            keyId: "test",
            publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
            revoked: false,
          },
        ],
      }),
    );
  });
  it("rolls back deployment, stages, targets, attempts, outbox, reservations and fence if audit persistence fails", async () => {
    await db!.execute(
      sql`CREATE FUNCTION issue169_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='deployment.accepted' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`,
    );
    await db!.execute(
      sql`CREATE TRIGGER issue169_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION issue169_fail_audit()`,
    );
    const key = randomUUID();
    try {
      await expect(repository().create(request(), key)).rejects.toThrow();
      expect(
        await db!
          .select()
          .from(otaDeployments)
          .where(eq(otaDeployments.idempotencyKey, key)),
      ).toHaveLength(0);
      expect(
        await db!
          .select()
          .from(otaTargets)
          .where(inArray(otaTargets.deviceId, ids)),
      ).toHaveLength(0);
      expect(
        await db!
          .select()
          .from(otaReservations)
          .where(inArray(otaReservations.deviceId, ids)),
      ).toHaveLength(0);
      expect(
        (
          await db!
            .select()
            .from(otaDeviceStates)
            .where(inArray(otaDeviceStates.deviceId, ids))
        ).every((s) => s.highestFence === 0n),
      ).toBe(true);
    } finally {
      await db!.execute(sql`DROP TRIGGER issue169_fail_audit ON audit_logs`);
      await db!.execute(sql`DROP FUNCTION issue169_fail_audit()`);
    }
    expect((await repository().create(request(), key)).targetCount).toBe(10);
  });
});
