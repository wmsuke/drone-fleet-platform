import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import {
  createDatabase,
  createOtaRepository,
  devices,
  releases,
  otaDeployments,
  otaStages,
  otaTargets,
  otaReservations,
  otaAttempts,
  otaOutbox,
  otaEvents,
  otaQueries,
  otaEvaluations,
  otaRejections,
  otaDeviceStates,
  otaInventories,
} from "@drone-fleet/database";
import {
  otaRequestMessageSchema,
  type OtaEventMessage,
} from "@drone-fleet/protocol";
import { otaFixture } from "../../../packages/database/test/ota-fixture.js";
import { createDeploymentRepository } from "../src/deployment-repository.js";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandRepository } from "../src/command-repository.js";
import { createCommandService } from "../src/command-service.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
describe.skipIf(!enabled)("OTA evidence storage and progress API", () => {
  const database = enabled ? createDatabase() : undefined,
    db = database?.db;
  let f: ReturnType<typeof otaFixture>, now: Date;
  let repository: ReturnType<typeof createOtaRepository>;
  async function clean() {
    if (!f) return;
    const id = f.apply.attemptId,
      deploymentId = f.apply.deploymentId;
    await db!.delete(otaQueries).where(eq(otaQueries.attemptId, id));
    await db!.delete(otaEvaluations).where(eq(otaEvaluations.attemptId, id));
    await db!.delete(otaEvents).where(eq(otaEvents.attemptId, id));
    await db!
      .delete(otaRejections)
      .where(eq(otaRejections.deviceId, f.apply.deviceId));
    await db!
      .delete(otaOutbox)
      .where(eq(otaOutbox.commandId, f.apply.commandId));
    await db!.delete(otaAttempts).where(eq(otaAttempts.attemptId, id));
    await db!
      .delete(otaReservations)
      .where(eq(otaReservations.deviceId, f.apply.deviceId));
    await db!
      .delete(otaTargets)
      .where(eq(otaTargets.deploymentId, deploymentId));
    await db!.delete(otaStages).where(eq(otaStages.deploymentId, deploymentId));
    await db!
      .delete(otaDeployments)
      .where(eq(otaDeployments.deploymentId, deploymentId));
    await db!
      .delete(otaInventories)
      .where(eq(otaInventories.deviceId, f.apply.deviceId));
    await db!
      .delete(otaDeviceStates)
      .where(eq(otaDeviceStates.deviceId, f.apply.deviceId));
    await db!.delete(devices).where(eq(devices.deviceId, f.apply.deviceId));
  }
  async function queries() {
    for (const event of f.events)
      if (event.type === "HEALTH") {
        const base = Object.fromEntries(
          Object.entries(f.apply).filter(([key]) => key !== "purpose"),
        );
        const createdAt = new Date(Date.parse(event.measuredAt) - 100);
        const expiresAt = new Date(createdAt.getTime() + 15000);
        const payload = otaRequestMessageSchema.parse({
          ...base,
          type: "QUERY_STATE",
          commandId: event.queryCommandId,
          applyCommandId: f.apply.commandId,
          challengeId: event.challengeId,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          resultDeadline: expiresAt.toISOString(),
        });
        await db!.insert(otaQueries).values({
          commandId: event.queryCommandId,
          attemptId: event.attemptId,
          challengeId: event.challengeId,
          expectedBootId: f.bootId,
          expectedSupervisorBootId: f.supervisorBootId,
          payload,
          createdAt,
          expiresAt,
          nextAttemptAt: expiresAt,
          attempts: 1,
        });
      }
  }
  async function ingest(index: number, event = f.events[index]!) {
    now = f.rows[index]!.storedAt;
    return repository.ingest(event, f.rows[index]!.receivedAt);
  }
  async function success() {
    await queries();
    for (let i = 0; i < f.events.length; i++) await ingest(i);
  }
  async function verdict() {
    return (
      await db!
        .select()
        .from(otaAttempts)
        .where(eq(otaAttempts.attemptId, f.apply.attemptId))
    )[0]!.evaluationStatus;
  }
  beforeAll(async () => {
    await migrate(db!, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });
  beforeEach(async () => {
    await clean();
    f = otaFixture();
    now = f.at(0);
    repository = createOtaRepository(db!, { clock: () => now });
    await db!.insert(devices).values({ deviceId: f.apply.deviceId });
    const manifest = {
      ...f.apply.release,
      application: "simulator",
      platform: "linux-arm64",
    };
    await db!.insert(releases).values({
      releaseId: f.apply.release.releaseId,
      application: "simulator",
      platform: "linux-arm64",
      version: `0.2.0-test.${randomUUID()}`,
      digest: f.apply.release.digest,
      envelope: { manifest },
    });
    await db!.insert(otaDeviceStates).values({
      deviceId: f.apply.deviceId,
      highestFence: 1n,
      snapshot: { bootId: f.bootId, ...f.apply.release },
      observedAt: f.at(0),
    });
    await db!.insert(otaDeployments).values({
      deploymentId: f.apply.deploymentId,
      idempotencyScope: "anonymous",
      idempotencyKey: randomUUID(),
      requestHash: "a".repeat(64),
      request: {},
      releaseId: f.apply.release.releaseId,
      releaseSnapshot: { manifest },
      policy: { evaluationVersion: "ota-health-v1" },
      targetCount: 1,
      createdAt: now,
      status: "RUNNING",
    });
    await db!.insert(otaStages).values({
      stageId: f.apply.stageId,
      deploymentId: f.apply.deploymentId,
      position: 0,
      status: "RUNNING",
      deviceIds: [f.apply.deviceId],
    });
    await db!.insert(otaTargets).values({
      targetId: f.apply.targetId,
      deploymentId: f.apply.deploymentId,
      stageId: f.apply.stageId,
      deviceId: f.apply.deviceId,
      snapshot: {},
      status: "UPDATING",
    });
    await db!
      .insert(otaReservations)
      .values({ deviceId: f.apply.deviceId, targetId: f.apply.targetId });
    // #171の解禁transactionをfixtureで表す。公開APIでstageを解禁したとは扱わない。
    await db!.insert(otaAttempts).values({
      attemptId: f.apply.attemptId,
      targetId: f.apply.targetId,
      commandId: f.apply.commandId,
      fence: 1n,
      startedAt: f.at(0),
      expiresAt: f.at(300000),
      resultDeadline: f.at(600000),
      deliveryStatus: "PENDING",
    });
    await db!.insert(otaOutbox).values({
      commandId: f.apply.commandId,
      topic: `fleet/v1/devices/${f.apply.deviceId}/ota-requests`,
      payload: JSON.stringify(f.apply),
      status: "PENDING",
      expiresAt: f.at(300000),
      nextAttemptAt: now,
    });
  });
  afterAll(async () => {
    if (database) {
      await clean();
      await database.client.end();
    }
  });
  it("commits facts before returning a stable receipt; duplicates do not refresh health", async () => {
    await queries();
    for (let i = 0; i < 9; i++) await ingest(i);
    const before = (
      await db!
        .select()
        .from(otaEvents)
        .where(eq(otaEvents.eventId, f.events[8]!.eventId))
    )[0]!;
    now = f.at(12000);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repository.ingest(f.events[8]!, now)),
    );
    for (const result of results) expect(result).toEqual(before.receipt);
    expect(
      (
        await db!
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, f.events[8]!.eventId))
      )[0]!.storedAt,
    ).toEqual(before.storedAt);
    expect(await verdict()).not.toBe("SUCCEEDED");
  });
  it("resumes after backend restart and exposes evidence and fixed denominators via API", async () => {
    await queries();
    for (let i = 0; i < 15; i++) await ingest(i);
    repository = createOtaRepository(db!, { clock: () => now });
    for (let i = 15; i < f.events.length; i++) await ingest(i);
    expect(await verdict()).toBe("SUCCEEDED");
    const app = buildApi(
      createDeviceRepository(db!),
      createCommandService(createCommandRepository(db!)),
      {
        deploymentRepository: createDeploymentRepository(db!, {
          directory: "/not-used",
          trustStorePath: "/not-used",
        }),
      },
    );
    try {
      const response = await app.inject({
        url: `/deployments/${f.apply.deploymentId}?eventLimit=2`,
      });
      expect(response.statusCode).toBe(200);
      const row = response.json();
      expect(row.stages[0].denominator).toBe(1);
      expect(row.stages[0].counts.SUCCEEDED).toBe(1);
      expect(row.targets[0].attempts[0]).toMatchObject({
        evaluationStatus: "SUCCEEDED",
        fence: "1",
        eventsTruncated: true,
      });
      expect(
        row.targets[0].attempts[0].evaluations[0].evidence.length,
      ).toBeGreaterThan(13);
      expect(
        (await app.inject({ url: "/deployments?limit=1" })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ url: "/deployments?limit=0" })).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: `/deployments/${randomUUID()}` })).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("handles out-of-order progress without reverting APPLIED, then fills a sequence gap", async () => {
    await queries();
    for (let i = 0; i < f.events.length; i++) if (i !== 2) await ingest(i);
    expect(await verdict()).not.toBe("SUCCEEDED");
    now = f.at(75000);
    await repository.ingest(f.events[2]!, now);
    expect(await verdict()).toBe("SUCCEEDED");
    expect(
      (
        await db!
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.attemptId, f.apply.attemptId))
      )[0]!.applicationStatus,
    ).toBe("APPLIED");
  });
  it("preserves canonical events and latches a same-ID or same-sequence conflict", async () => {
    await ingest(0);
    const conflict = {
      ...f.events[0]!,
      type: "PROGRESS",
      state: "DOWNLOADING",
    } as OtaEventMessage;
    now = f.at(1000);
    expect(await repository.ingest(conflict, now)).toBeNull();
    expect(
      await repository.ingest({ ...conflict, eventId: randomUUID() }, now),
    ).toBeNull();
    expect(
      (
        await db!
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, f.events[0]!.eventId))
      )[0]!.payload.state,
    ).toBe("RECEIVED");
    expect(await verdict()).toBe("UNCERTAIN");
  });
  it("does not let unknown scope, higher device fence or stale attempts change current state", async () => {
    await ingest(0);
    now = f.at(1000);
    expect(
      await repository.ingest(
        { ...f.events[1]!, attemptId: randomUUID() },
        now,
      ),
    ).toBeNull();
    expect(
      await repository.ingest(
        { ...f.events[1]!, deploymentId: randomUUID() },
        now,
      ),
    ).toBeNull();
    await db!
      .update(otaDeviceStates)
      .set({ highestFence: 2n })
      .where(eq(otaDeviceStates.deviceId, f.apply.deviceId));
    await ingest(1);
    expect(
      (
        await db!
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, f.events[1]!.eventId))
      )[0]!.reason,
    ).toBe("STALE_ATTEMPT");
    expect(
      (
        await db!
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.attemptId, f.apply.attemptId))
      )[0]!.applicationStatus,
    ).toBe("RECEIVED");
  });
  it("does not accept unknown/consumed challenges, different boots or deadline equality", async () => {
    await queries();
    for (let i = 0; i < 9; i++) await ingest(i);
    const health = f.events[9]!;
    if (health.type !== "HEALTH") throw new Error("fixture");
    now = f.rows[9]!.storedAt;
    await repository.ingest({ ...health, challengeId: randomUUID() }, now);
    expect(
      (
        await db!
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, health.eventId))
      )[0]!.reason,
    ).toBe("CHALLENGE_USED_OR_MISMATCH");
    const used = f.events[8]!;
    if (used.type !== "HEALTH") throw new Error("fixture");
    await repository.ingest(
      { ...used, sequence: 999, eventId: randomUUID() },
      now,
    );
    const [reused] = await db!
      .select()
      .from(otaEvents)
      .where(eq(otaEvents.sequence, 999n));
    expect(reused!.reason).toBe("CHALLENGE_USED_OR_MISMATCH");
    const boot = f.events[10]!;
    if (boot.type !== "HEALTH") throw new Error("fixture");
    now = f.rows[10]!.storedAt;
    await repository.ingest(
      { ...boot, running: { ...boot.running, bootId: randomUUID() } },
      now,
    );
    expect(
      (
        await db!
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, boot.eventId))
      )[0]!.reason,
    ).toBe("BOOT_MISMATCH");
    now = f.at(600000);
    await repository.ingest(f.events.at(-1)!, now);
    await repository.tick();
    expect(await verdict()).toBe("UNCERTAIN");
  });
  it("retains successful history when a later valid health failure arrives", async () => {
    await success();
    expect(await verdict()).toBe("SUCCEEDED");
    now = f.at(75000);
    const query = (await repository.tick()).find(
      (s) => JSON.parse(s.payload).challengeId !== null,
    )!;
    const q = JSON.parse(query.payload);
    const previous = f.events[8]!;
    if (previous.type !== "HEALTH") throw new Error("fixture");
    const event: OtaEventMessage = {
      ...previous,
      eventId: randomUUID(),
      sequence: f.events.length,
      queryCommandId: q.commandId,
      challengeId: q.challengeId,
      timestamp: now.toISOString(),
      measuredAt: now.toISOString(),
      sampleMonotonicMs: 75000,
      checks: { ...previous.checks, sqlite: "FAILED" },
    };
    await repository.ingest(event, now);
    expect(await verdict()).toBe("FAILED");
    expect(
      (
        await db!
          .select()
          .from(otaEvaluations)
          .where(eq(otaEvaluations.attemptId, f.apply.attemptId))
      ).some((e) => e.status === "SUCCEEDED"),
    ).toBe(true);
    expect(
      (
        await db!
          .select()
          .from(otaDeployments)
          .where(eq(otaDeployments.deploymentId, f.apply.deploymentId))
      )[0]!.status,
    ).toBe("WAITING_FOR_HUMAN");
    expect(
      (
        await db!
          .select()
          .from(otaStages)
          .where(eq(otaStages.stageId, f.apply.stageId))
      )[0]!.status,
    ).toBe("STOPPING");
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(eq(otaReservations.deviceId, f.apply.deviceId)),
    ).toHaveLength(1);
  });
  it("persists query retries before publish, resumes them, and expires unreported attempts", async () => {
    await ingest(0);
    now = f.at(1000);
    const [first] = await repository.tick();
    expect(first).toBeDefined();
    expect(
      (
        await db!
          .select()
          .from(otaQueries)
          .where(eq(otaQueries.commandId, first!.commandId))
      )[0]!.attempts,
    ).toBe(1);
    repository = createOtaRepository(db!, { clock: () => now });
    now = f.at(2100);
    expect((await repository.tick())[0]!.payload).toBe(first!.payload);
    // 受領済みなら開始期限だけで適用を取り消さない。
    now = f.at(300000);
    await repository.tick();
    expect(
      (
        await db!
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.attemptId, f.apply.attemptId))
      )[0]!.deliveryStatus,
    ).toBe("ACKNOWLEDGED");
    now = f.at(700000);
    await repository.tick();
    expect(await verdict()).toBe("UNCERTAIN");
  });
  it("rolls back event, challenge consumption and evaluation if persistence fails", async () => {
    await queries();
    for (let i = 0; i < 8; i++) await ingest(i);
    await db!.execute(
      sql`CREATE FUNCTION issue170_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`,
    );
    await db!.execute(
      sql`CREATE TRIGGER issue170_fail_event BEFORE INSERT ON ota_events FOR EACH ROW EXECUTE FUNCTION issue170_fail_event()`,
    );
    const event = f.events[8]!;
    if (event.type !== "HEALTH") throw new Error("fixture");
    try {
      await expect(ingest(8)).rejects.toThrow();
      expect(
        (
          await db!
            .select()
            .from(otaQueries)
            .where(eq(otaQueries.commandId, event.queryCommandId))
        )[0]!.consumedEventId,
      ).toBeNull();
    } finally {
      await db!.execute(sql`DROP TRIGGER issue170_fail_event ON ota_events`);
      await db!.execute(sql`DROP FUNCTION issue170_fail_event()`);
    }
    expect(await ingest(8)).not.toBeNull();
  });
  it("registers observed inventory without resetting fences or refreshing duplicate/stale observations", async () => {
    now = f.at(1000);
    const inventory = {
      schemaVersion: 1,
      type: "INVENTORY",
      deviceId: f.apply.deviceId,
      eventId: randomUUID(),
      sequence: 0,
      supervisorBootId: f.supervisorBootId,
      timestamp: now.toISOString(),
      measuredAt: now.toISOString(),
      sampleAgeMs: 0,
      running: { release: f.apply.release, bootId: f.bootId },
      capabilities: {
        application: "simulator",
        platform: "linux-arm64",
        nodeVersion: "22.13.0",
        otaProtocolVersion: "1.0.0",
        supervisorVersion: "1.0.0",
        stateSchemaVersion: "1.0.0",
        healthContractVersion: "ota-health-v1",
      },
    };
    const receipt = await repository.inventory(inventory, now);
    expect(receipt).not.toBeNull();
    now = f.at(5000);
    expect(await repository.inventory(inventory, now)).toEqual(receipt);
    expect(
      (
        await db!
          .select()
          .from(otaDeviceStates)
          .where(eq(otaDeviceStates.deviceId, f.apply.deviceId))
      )[0],
    ).toMatchObject({
      observedAt: f.at(1000),
      highestFence: 1n,
      inventorySequence: 0n,
    });
    expect(
      await repository.inventory({ ...inventory, eventId: randomUUID() }, now),
    ).toBeNull();
    now = f.at(30000);
    await repository.inventory(
      { ...inventory, eventId: randomUUID(), sequence: 1 },
      now,
    );
    expect(
      (
        await db!
          .select()
          .from(otaDeviceStates)
          .where(eq(otaDeviceStates.deviceId, f.apply.deviceId))
      )[0]!.observedAt,
    ).toEqual(f.at(1000));
    expect(
      await db!
        .select()
        .from(otaRejections)
        .where(eq(otaRejections.deviceId, f.apply.deviceId)),
    ).toHaveLength(1);
  });
  it("rejects an old running version and stores the mismatch without declaring success", async () => {
    for (let i = 0; i < 6; i++) await ingest(i);
    const version = f.events[6]!;
    if (version.type !== "VERSION") throw new Error("fixture");
    await ingest(6, {
      ...version,
      running: {
        ...version.running,
        release: { ...version.running.release, version: "0.1.0" },
      },
    });
    expect(await verdict()).toBe("UNCERTAIN");
    expect(
      (
        await db!
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, version.eventId))
      )[0]!.reason,
    ).toBe("RELEASE_MISMATCH");
  });
  it("treats exact query expiry as late and does not consume its challenge", async () => {
    await queries();
    for (let i = 0; i < 8; i++) await ingest(i);
    const health = f.events[8]!;
    if (health.type !== "HEALTH") throw new Error("fixture");
    const [query] = await db!
      .select()
      .from(otaQueries)
      .where(eq(otaQueries.commandId, health.queryCommandId));
    now = query!.expiresAt;
    await repository.ingest(health, now);
    expect(
      (
        await db!
          .select()
          .from(otaEvents)
          .where(eq(otaEvents.eventId, health.eventId))
      )[0]!.reason,
    ).toBe("INVALID_QUERY");
    expect(
      (
        await db!
          .select()
          .from(otaQueries)
          .where(eq(otaQueries.commandId, health.queryCommandId))
      )[0]!.consumedEventId,
    ).toBeNull();
    expect(await verdict()).not.toBe("SUCCEEDED");
  });
  it("expires unacknowledged delivery at the start deadline without declaring the update stopped", async () => {
    now = f.at(300000);
    await repository.tick();
    expect(
      (
        await db!
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.attemptId, f.apply.attemptId))
      )[0]!.deliveryStatus,
    ).toBe("EXPIRED");
    await repository.ingest(f.events[0]!, now);
    expect(
      (
        await db!
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.attemptId, f.apply.attemptId))
      )[0]!.deliveryStatus,
    ).toBe("EXPIRED");
    expect(await verdict()).not.toBe("SUCCEEDED");
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(eq(otaReservations.deviceId, f.apply.deviceId)),
    ).toHaveLength(1);
  });
  it("does not hide a late negative sample behind a successful historical evaluation", async () => {
    await success();
    now = f.at(90000);
    const old = f.events[8]!;
    if (old.type !== "HEALTH") throw new Error("fixture");
    await repository.ingest(
      {
        ...old,
        eventId: randomUUID(),
        sequence: f.events.length,
        checks: { ...old.checks, sqlite: "FAILED" },
      },
      now,
    );
    expect(await verdict()).toBe("UNCERTAIN");
    expect(
      (
        await db!
          .select()
          .from(otaEvaluations)
          .where(eq(otaEvaluations.attemptId, f.apply.attemptId))
      ).some((e) => e.status === "SUCCEEDED"),
    ).toBe(true);
  });
});
