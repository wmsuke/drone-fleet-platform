import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, sql, inArray } from "drizzle-orm";
import {
  createDatabase,
  createOtaRecovery,
  createOtaRepository,
  createOtaRollout,
  otaRecoveries,
  otaInterventions,
  auditLogs,
  createOtaInterventions,
  otaAttempts,
  otaTargets,
  otaDeployments,
  otaStages,
  otaOutbox,
  otaDeviceStates,
  otaReservations,
  otaInventories,
  otaEvents,
  otaEvaluations,
  otaQueries,
  otaStops,
  otaRollouts,
  otaActions,
  otaRejections,
  otaDispatches,
  devices,
  releases,
} from "@drone-fleet/database";
import { packBundle, publishArtifact } from "@drone-fleet/releases";
import {
  otaEventMessageSchema,
  otaRequestMessageSchema,
  serializeOtaEvent,
  type OtaApplyRequest,
} from "@drone-fleet/protocol";
import {
  makeEnvelope,
  identity,
  applyRequest,
  pair,
} from "../../ota-supervisor/test/support.js";
import { otaFixture } from "../../../packages/database/test/ota-fixture.js";
import { createDeploymentRepository } from "../src/deployment-repository.js";
import { createDeploymentRecovery } from "../src/deployment-control.js";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandService } from "../src/command-service.js";
import { createCommandRepository } from "../src/command-repository.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
describe.skipIf(!enabled)("bounded OTA recovery with PostgreSQL", () => {
  const database = enabled ? createDatabase() : undefined,
    db = database?.db;
  let now: Date,
    root: OtaApplyRequest,
    old: ReturnType<typeof makeEnvelope>,
    next: ReturnType<typeof makeEnvelope>,
    bootId: string,
    supervisorBootId: string,
    inventorySequence: number;
  let repository: ReturnType<typeof createOtaRecovery>,
    validatorAvailable: boolean;
  const ready = {
    eventLoop: "PASSED",
    telemetry: "PASSED",
    sqlite: "PASSED",
    commandReady: "PASSED",
    mqtt: "PASSED",
    subscriptions: "PASSED",
    receipts: "PASSED",
  } as const;
  async function cleanup() {
    if (!root) return;
    await db!
      .delete(otaInterventions)
      .where(eq(otaInterventions.deploymentId, root.deploymentId));
    const attempts = await db!
        .select()
        .from(otaAttempts)
        .where(eq(otaAttempts.targetId, root.targetId)),
      ids = attempts.map((a) => a.attemptId),
      commands = attempts.map((a) => a.commandId);
    await db!
      .delete(otaRecoveries)
      .where(eq(otaRecoveries.deploymentId, root.deploymentId));
    for (const table of [
      otaQueries,
      otaStops,
      otaDispatches,
      otaEvaluations,
      otaEvents,
    ])
      await db!.delete(table).where(inArray(table.attemptId, ids));
    await db!
      .delete(otaRejections)
      .where(eq(otaRejections.deviceId, root.deviceId));
    await db!
      .delete(otaActions)
      .where(eq(otaActions.deploymentId, root.deploymentId));
    await db!
      .delete(otaRollouts)
      .where(eq(otaRollouts.deploymentId, root.deploymentId));
    await db!.delete(otaOutbox).where(inArray(otaOutbox.commandId, commands));
    await db!.delete(otaAttempts).where(inArray(otaAttempts.attemptId, ids));
    await db!
      .delete(otaReservations)
      .where(eq(otaReservations.targetId, root.targetId));
    await db!.delete(otaTargets).where(eq(otaTargets.targetId, root.targetId));
    await db!
      .delete(otaStages)
      .where(eq(otaStages.deploymentId, root.deploymentId));
    await db!
      .delete(otaDeployments)
      .where(eq(otaDeployments.deploymentId, root.deploymentId));
    await db!
      .delete(otaInventories)
      .where(eq(otaInventories.deviceId, root.deviceId));
    await db!
      .delete(otaDeviceStates)
      .where(eq(otaDeviceStates.deviceId, root.deviceId));
    await db!.delete(devices).where(eq(devices.deviceId, root.deviceId));
  }
  async function inventory(
    active = old,
    bytes = 256,
    checks: Record<string, string> = ready,
  ) {
    now = new Date(now.getTime() + 1);
    await createOtaRepository(db!, { clock: () => now }).inventory(
      {
        schemaVersion: 1,
        type: "INVENTORY",
        deviceId: root.deviceId,
        eventId: randomUUID(),
        sequence: inventorySequence++,
        supervisorBootId,
        timestamp: now.toISOString(),
        measuredAt: now.toISOString(),
        sampleAgeMs: 0,
        running: { release: identity(active), bootId },
        capabilities: {
          application: "simulator",
          platform: active.manifest.platform,
          nodeVersion: "22.13.0",
          otaProtocolVersion: "1.0.0",
          supervisorVersion: "1.0.0",
          stateSchemaVersion: "1.0.0",
          healthContractVersion: "ota-health-v1",
        },
        readiness: checks,
        recovery: {
          knownGood: identity(old),
          attemptId: root.attemptId,
          phase: "FAILED",
          downloadedBytes: bytes,
          detectedAt: new Date(now.getTime() - 10000).toISOString(),
          budgetDeadline: new Date(now.getTime() + 890000).toISOString(),
        },
      },
      now,
    );
  }
  async function fact(payload: Record<string, unknown>, sequence: number) {
    const e = otaEventMessageSchema.parse({
      schemaVersion: 1,
      deviceId: root.deviceId,
      deploymentId: root.deploymentId,
      stageId: root.stageId,
      targetId: root.targetId,
      attemptId: root.attemptId,
      fence: root.fence,
      release: root.release,
      applyCommandId: root.commandId,
      eventId: randomUUID(),
      sequence,
      supervisorBootId,
      timestamp: now.toISOString(),
      ...payload,
    });
    await db!.insert(otaEvents).values({
      eventId: e.eventId,
      attemptId: e.attemptId,
      sequence: BigInt(sequence),
      payloadHash: createHash("sha256")
        .update(serializeOtaEvent(e))
        .digest("hex"),
      payload: e,
      occurredAt: now,
      receivedAt: now,
      storedAt: now,
      acceptance: "ACCEPTED",
    });
    return e;
  }
  async function request(
    kind: "RETRY" | "ROLLBACK" = "RETRY",
    key = randomUUID(),
  ) {
    return repository.request(
      root.deploymentId,
      root.targetId,
      key,
      kind,
      "OPERATOR_APPROVAL",
    );
  }
  async function releaseRetry() {
    const accepted = await request();
    now = new Date(now.getTime() + 30000);
    await inventory();
    const sends = await repository.tick();
    return { accepted, sends };
  }
  beforeAll(async () => {
    await migrate(db!, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });
  beforeEach(async () => {
    await cleanup();
    now = new Date();
    inventorySequence = 0;
    validatorAvailable = true;
    bootId = randomUUID();
    supervisorBootId = randomUUID();
    const suffix = randomUUID();
    old = makeEnvelope(
      packBundle(Buffer.from("console.info('old');")),
      `0.1.0-test.${suffix}`,
    );
    next = makeEnvelope(
      packBundle(Buffer.from("console.info('next');")),
      `0.2.0-test.${suffix}`,
    );
    root = {
      ...applyRequest(next),
      deviceId: `issue172-${suffix}`,
      createdAt: new Date(now.getTime() - 80000).toISOString(),
      expiresAt: new Date(now.getTime() + 220000).toISOString(),
      resultDeadline: new Date(now.getTime() + 520000).toISOString(),
    };
    for (const e of [old, next])
      await db!.insert(releases).values({ ...e.manifest, envelope: e });
    await db!.insert(devices).values({ deviceId: root.deviceId });
    await db!.insert(otaDeviceStates).values({
      deviceId: root.deviceId,
      highestFence: 1n,
      snapshot: {},
      observedAt: now,
    });
    await db!.insert(otaDeployments).values({
      deploymentId: root.deploymentId,
      idempotencyScope: "anonymous",
      idempotencyKey: randomUUID(),
      requestHash: "a".repeat(64),
      request: {},
      releaseId: next.manifest.releaseId,
      releaseSnapshot: next,
      policy: {},
      status: "PAUSED",
      targetCount: 1,
      createdAt: new Date(root.createdAt),
    });
    await db!.insert(otaStages).values({
      stageId: root.stageId,
      deploymentId: root.deploymentId,
      position: 0,
      status: "PAUSED",
      deviceIds: [root.deviceId],
    });
    await db!.insert(otaTargets).values({
      targetId: root.targetId,
      deploymentId: root.deploymentId,
      stageId: root.stageId,
      deviceId: root.deviceId,
      snapshot: identity(old),
      status: "FAILED",
    });
    await db!
      .insert(otaReservations)
      .values({ deviceId: root.deviceId, targetId: root.targetId });
    await db!.insert(otaAttempts).values({
      attemptId: root.attemptId,
      targetId: root.targetId,
      commandId: root.commandId,
      fence: 1n,
      startedAt: new Date(root.createdAt),
      expiresAt: new Date(root.expiresAt),
      resultDeadline: new Date(root.resultDeadline),
      deliveryStatus: "ACKNOWLEDGED",
      applicationStatus: "FAILED",
      evaluationStatus: "FAILED",
    });
    await db!.insert(otaOutbox).values({
      commandId: root.commandId,
      topic: `fleet/v1/devices/${root.deviceId}/ota-requests`,
      payload: JSON.stringify(root),
      status: "ACKNOWLEDGED",
      expiresAt: new Date(root.expiresAt),
      nextAttemptAt: now,
      attempts: 1,
    });
    const failure = await fact(
      {
        type: "PROGRESS",
        requestType: "APPLY_RELEASE",
        state: "FAILED",
        commandId: root.commandId,
        reason: "DOWNLOAD_FAILED",
        downloadedBytes: 256,
      },
      0,
    );
    await fact(
      {
        type: "STATE",
        state: "FAILED",
        queryCommandId: randomUUID(),
        running: { release: identity(old), bootId },
      },
      1,
    );
    await db!.insert(otaEvaluations).values({
      evaluationId: randomUUID(),
      attemptId: root.attemptId,
      status: "FAILED",
      reason: "DEVICE_FAILURE",
      evidence: [failure.eventId],
      fingerprint: randomUUID(),
      evaluatedAt: new Date(now.getTime() - 10000),
    });
    await db!.insert(otaRollouts).values({
      deploymentId: root.deploymentId,
      stoppedAt: new Date(now.getTime() - 5000),
      stopReason: "FAILURE_THRESHOLD",
    });
    await inventory();
    repository = createOtaRecovery(db!, {
      clock: () => now,
      random: () => 0,
      validate: async () => {
        if (!validatorAvailable) throw new Error("revoked or missing artifact");
      },
    });
  });
  afterAll(async () => {
    if (database) {
      await cleanup();
      await database.client.end();
    }
  });

  it("records recovery approval once, links anonymous audit and keeps observed recovery separate", async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([
      repository.request(
        root.deploymentId,
        root.targetId,
        key,
        "RETRY",
        "CHECKED_FAILURE",
      ),
      repository.request(
        root.deploymentId,
        root.targetId,
        key,
        "RETRY",
        "CHECKED_FAILURE",
      ),
    ]);
    expect(a).toEqual(b);
    const records = createOtaInterventions(db!);
    const page = await records.interventions(root.deploymentId, 20);
    expect(page!.items).toHaveLength(1);
    const i = page!.items[0]!;
    expect(i).toMatchObject({
      interventionId: a.interventionId,
      actorKind: "anonymous",
      actorId: null,
      category: "FAULT_RESPONSE",
      kind: "RETRY_APPROVAL",
      operationResult: "ACCEPTED",
      durationMs: null,
      cost: null,
      durationSource: null,
      excludesAutonomousCompletion: true,
      scope: [{ targetId: root.targetId, attemptId: a.attemptId }],
      recovery: {
        recoveryId: a.recoveryId,
        status: "WAITING",
        downloadedBytes: null,
        cost: null,
      },
    });
    expect(i).not.toHaveProperty("key");
    const [audit] = await db!
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.eventId, i.auditEventId));
    expect(audit).toMatchObject({
      actorKind: "anonymous",
      actorId: null,
      action: "deployment.recovery_requested",
      targetId: root.deploymentId,
      metadata: { interventionId: i.interventionId, reason: "CHECKED_FAILURE" },
    });
    now = new Date(String(a.notBefore));
    await inventory();
    await repository.tick();
    await repository.tick();
    const after = await records.interventions(root.deploymentId, 20);
    expect(after!.items).toHaveLength(1);
    expect(after!.items[0]!.recovery!.status).toBe("RUNNING");
    expect(
      (await createDeploymentRepository(db!, {
        directory: "/unused",
        trustStorePath: "/unused",
      }).find(root.deploymentId, 1))!.interventionSummary,
    ).toMatchObject({
      recordedCount: 1,
      faultResponseCount: 1,
      excludesAutonomousCompletion: true,
      legacyOperationCount: 0,
    });
  });
  it("records rejected rollback as intervention without claiming restoration or known cost", async () => {
    const result = await repository.request(
      root.deploymentId,
      root.targetId,
      randomUUID(),
      "ROLLBACK",
      "INSPECTED",
    );
    expect(result.status).toBe("UNAVAILABLE");
    const page = await createOtaInterventions(db!).interventions(
      root.deploymentId,
      20,
    );
    expect(page!.items[0]).toMatchObject({
      interventionId: result.interventionId,
      kind: "ROLLBACK_APPROVAL",
      operationResult: "REJECTED",
      cost: null,
      durationMs: null,
      recovery: { status: "UNAVAILABLE", startedAt: null },
    });
  });
  it("does not treat legacy operations without intervention records as autonomous", async () => {
    await db!.insert(otaActions).values({
      actionId: randomUUID(),
      deploymentId: root.deploymentId,
      key: randomUUID(),
      requestHash: "a".repeat(64),
      action: "stop",
      reason: "LEGACY_STOP",
      response: {},
      createdAt: now,
    });
    const repo = createDeploymentRepository(db!, {
      directory: "/unused",
      trustStorePath: "/unused",
    });
    expect(
      (await repo.find(root.deploymentId, 1))!.interventionSummary,
    ).toMatchObject({
      recordedCount: 0,
      legacyOperationCount: 1,
      excludesAutonomousCompletion: true,
    });
  });
  it("tracks open and completed human review idempotently without clearing uncertainty or reservations", async () => {
    await db!
      .update(otaDeployments)
      .set({ status: "WAITING_FOR_HUMAN" })
      .where(eq(otaDeployments.deploymentId, root.deploymentId));
    const r = createOtaInterventions(db!),
      key = randomUUID();
    const [a, b] = await Promise.all([
      r.startReview(root.deploymentId, key, "INSPECTING"),
      r.startReview(root.deploymentId, key, "INSPECTING"),
    ]);
    expect(a).toEqual(b);
    expect(
      (await r.interventions(root.deploymentId, 20))!.items[0],
    ).toMatchObject({
      operationResult: "OPEN",
      finishedAt: null,
      durationMs: null,
      cost: null,
    });
    await expect(
      r.startReview(root.deploymentId, randomUUID(), "OTHER_REVIEW"),
    ).rejects.toMatchObject({ reason: "HUMAN_REVIEW_ACTIVE" });
    await expect(
      r.startReview(root.deploymentId, key, "OTHER_REASON"),
    ).rejects.toMatchObject({ reason: "IDEMPOTENCY_CONFLICT" });
    const finishKey = randomUUID(),
      input = {
        reason: "NEEDS_ONSITE_INSPECTION",
        outcome: "ESCALATED" as const,
      };
    const [c, d] = await Promise.all([
      r.completeReview(root.deploymentId, a.interventionId, finishKey, input),
      r.completeReview(root.deploymentId, a.interventionId, finishKey, input),
    ]);
    expect(c).toEqual(d);
    await expect(
      r.completeReview(root.deploymentId, a.interventionId, finishKey, {
        ...input,
        outcome: "KEEP_STOPPED",
      }),
    ).rejects.toMatchObject({ reason: "IDEMPOTENCY_CONFLICT" });
    expect(await r.startReview(root.deploymentId, key, "INSPECTING")).toEqual(
      a,
    );
    const i = (await r.interventions(root.deploymentId, 20))!.items[0]!;
    expect(i).toMatchObject({
      operationResult: "ESCALATED",
      durationMs: null,
      cost: null,
      completionReason: "NEEDS_ONSITE_INSPECTION",
    });
    expect(i.finishedAt).not.toBeNull();
    const [audit] = await db!
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.eventId, i.completionAuditEventId!));
    expect(audit!.metadata.interventionId).toBe(i.interventionId);
    expect(
      (
        await db!
          .select()
          .from(otaDeployments)
          .where(eq(otaDeployments.deploymentId, root.deploymentId))
      )[0]!.status,
    ).toBe("WAITING_FOR_HUMAN");
    expect(
      await db!
        .select()
        .from(otaReservations)
        .where(eq(otaReservations.targetId, root.targetId)),
    ).toHaveLength(1);
  });
  it("requires a new same-deployment recovery for review resolution and distinguishes reported duration from unknown", async () => {
    const r = createOtaInterventions(db!);
    const start = await r.startReview(
      root.deploymentId,
      randomUUID(),
      "INSPECTING",
    );
    await expect(
      r.completeReview(root.deploymentId, start.interventionId, randomUUID(), {
        reason: "CHECKED",
        outcome: "RECOVERY_REQUESTED",
        recoveryId: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: "INVALID_RECOVERY_REFERENCE" });
    await expect(
      r.completeReview(root.deploymentId, start.interventionId, randomUUID(), {
        reason: "CHECKED",
        outcome: "KEEP_STOPPED",
        durationMs: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toMatchObject({ reason: "INVALID_INTERVENTION_DURATION" });
    now = new Date(Math.max(Date.now() + 10, now.getTime() + 1));
    await inventory();
    const recovery = await request();
    await r.completeReview(
      root.deploymentId,
      start.interventionId,
      randomUUID(),
      {
        reason: "APPROVED_RETRY",
        outcome: "RECOVERY_REQUESTED",
        recoveryId: String(recovery.recoveryId),
        durationMs: 1,
      },
    );
    const i = (await r.interventions(root.deploymentId, 20))!.items.find(
      (i) => i.interventionId === start.interventionId,
    )!;
    expect(i).toMatchObject({
      resolutionRecoveryId: recovery.recoveryId,
      durationMs: 1,
      durationSource: "OPERATOR_REPORTED",
      cost: null,
      operationResult: "RECOVERY_REQUESTED",
    });
    expect(await r.interventions(randomUUID(), 20)).toBeNull();
    await expect(
      r.completeReview(randomUUID(), start.interventionId, randomUUID(), {
        reason: "CHECKED",
        outcome: "KEEP_STOPPED",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("does not keep the new recovery, fence or audit if intervention persistence fails", async () => {
    await db!.execute(
      sql`CREATE FUNCTION issue173_reject_intervention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`,
    );
    await db!.execute(
      sql`CREATE TRIGGER issue173_reject_intervention BEFORE INSERT ON ota_interventions FOR EACH ROW EXECUTE FUNCTION issue173_reject_intervention()`,
    );
    try {
      await expect(request()).rejects.toThrow();
      expect(
        await db!
          .select()
          .from(otaRecoveries)
          .where(eq(otaRecoveries.deploymentId, root.deploymentId)),
      ).toHaveLength(0);
      expect(
        await db!
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.targetId, root.targetId)),
      ).toHaveLength(1);
      expect(
        await db!
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.targetId, root.deploymentId),
              eq(auditLogs.action, "deployment.recovery_requested"),
            ),
          ),
      ).toHaveLength(0);
      expect(
        (
          await db!
            .select()
            .from(otaDeviceStates)
            .where(eq(otaDeviceStates.deviceId, root.deviceId))
        )[0]!.highestFence,
      ).toBe(1n);
    } finally {
      await db!.execute(
        sql`DROP TRIGGER issue173_reject_intervention ON ota_interventions`,
      );
      await db!.execute(sql`DROP FUNCTION issue173_reject_intervention()`);
    }
  });
  it("keeps a review open when completion audit fails and protects completed history", async () => {
    const r = createOtaInterventions(db!),
      start = await r.startReview(
        root.deploymentId,
        randomUUID(),
        "INSPECTING",
      );
    await db!.execute(
      sql`CREATE FUNCTION issue173_reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='deployment.intervention_completed' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`,
    );
    await db!.execute(
      sql`CREATE TRIGGER issue173_reject_completion BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION issue173_reject_completion()`,
    );
    const key = randomUUID(),
      input = { reason: "CHECKED", outcome: "KEEP_STOPPED" as const };
    try {
      await expect(
        r.completeReview(root.deploymentId, start.interventionId, key, input),
      ).rejects.toThrow();
      expect(
        (await r.interventions(root.deploymentId, 20))!.items[0]!.finishedAt,
      ).toBeNull();
    } finally {
      await db!.execute(
        sql`DROP TRIGGER issue173_reject_completion ON audit_logs`,
      );
      await db!.execute(sql`DROP FUNCTION issue173_reject_completion()`);
    }
    await expect(
      db!
        .update(otaInterventions)
        .set({ actorId: "admin" })
        .where(eq(otaInterventions.interventionId, start.interventionId)),
    ).rejects.toThrow();
    await r.completeReview(root.deploymentId, start.interventionId, key, input);
    await expect(
      db!
        .update(otaInterventions)
        .set({ durationMs: 0 })
        .where(eq(otaInterventions.interventionId, start.interventionId)),
    ).rejects.toThrow();
  });
  it("validates intervention HTTP bodies, ignores forged actor headers and paginates without duplicates", async () => {
    const repo = createDeploymentRepository(db!, {
      directory: "/unused",
      trustStorePath: "/unused",
    });
    const app = buildApi(
      createDeviceRepository(db!),
      createCommandService(createCommandRepository(db!)),
      { deploymentRepository: repo, auditDatabase: db! },
    );
    const url = `/deployments/${root.deploymentId}/interventions`,
      headers = {
        "Idempotency-Key": randomUUID(),
        "X-Actor-Id": "administrator",
        "X-Request-Id": randomUUID(),
      };
    try {
      for (const payload of [
        { reason: "CHECKED", actorId: "admin" },
        { reason: "token=secret" },
        { reason: "CHECKED", cost: 0 },
        { reason: "CHECKED", startedAt: new Date().toISOString() },
      ])
        expect(
          (await app.inject({ method: "POST", url, headers, payload }))
            .statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            payload: { reason: "CHECKED" },
          })
        ).statusCode,
      ).toBe(400);
      const start = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { reason: "CHECKED" },
      });
      expect(start.statusCode).toBe(202);
      expect(start.headers["x-request-id"]).not.toBe(headers["X-Request-Id"]);
      const finishUrl = `${url}/${start.json().interventionId}/complete`,
        endHeaders = { "Idempotency-Key": randomUUID() };
      expect(
        (
          await app.inject({
            method: "POST",
            url: finishUrl,
            headers: endHeaders,
            payload: { reason: "CHECKED", outcome: "SUCCEEDED" },
          })
        ).statusCode,
      ).toBe(400);
      const payload = { reason: "NEEDS_INSPECTION", outcome: "KEEP_STOPPED" };
      const end = await app.inject({
        method: "POST",
        url: finishUrl,
        headers: endHeaders,
        payload,
      });
      expect(end.statusCode).toBe(202);
      expect(
        (
          await app.inject({
            method: "POST",
            url: finishUrl,
            headers: endHeaders,
            payload,
          })
        ).json(),
      ).toEqual(end.json());
      await repo.startReview(root.deploymentId, randomUUID(), "SECOND_CHECK");
      const first = (
        await app.inject({ method: "GET", url: `${url}?limit=1` })
      ).json();
      expect(first.items[0]).toMatchObject({
        actorKind: "anonymous",
        actorId: null,
        durationMs: null,
      });
      const cursor = first.nextCursor;
      const second = (
        await app.inject({
          method: "GET",
          url: `${url}?limit=1&before=${cursor.startedAt}&beforeId=${cursor.interventionId}`,
        })
      ).json();
      expect(second.items[0].interventionId).not.toBe(
        first.items[0].interventionId,
      );
      expect(second.nextCursor).toBeNull();
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${url}?beforeId=${randomUUID()}`,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/deployments/${randomUUID()}/interventions`,
          })
        ).statusCode,
      ).toBe(404);
      const [audit] = await db!
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.eventId, second.items[0].auditEventId));
      expect(audit).toMatchObject({
        actorKind: "anonymous",
        actorId: null,
        requestId: start.headers["x-request-id"],
      });
      await db!
        .update(otaDeployments)
        .set({ status: "RUNNING" })
        .where(eq(otaDeployments.deploymentId, root.deploymentId));
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { "Idempotency-Key": randomUUID() },
            payload: { reason: "NEW_REVIEW" },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("persists one explicitly approved retry with jitter, a new identity and unchanged snapshots; replay is stable", async () => {
    const key = randomUUID(),
      results = await Promise.all([
        request("RETRY", key),
        request("RETRY", key),
      ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.status).toBe("WAITING");
    expect(await repository.tick()).toEqual([]);
    const [attempt] = await db!
      .select()
      .from(otaAttempts)
      .where(eq(otaAttempts.attemptId, results[0]!.attemptId as string));
    expect(attempt).toMatchObject({
      ordinal: 2,
      fence: 2n,
      previousAttemptId: root.attemptId,
      deliveryStatus: "HELD",
      startedAt: null,
    });
    now = new Date(now.getTime() + 30000);
    await inventory();
    const sends = (
      await Promise.all([repository.tick(), repository.tick()])
    ).flat();
    expect(sends).toHaveLength(1);
    const payload = otaRequestMessageSchema.parse(
      JSON.parse(sends[0]!.payload),
    );
    expect(payload.type).toBe("APPLY_RELEASE");
    expect(payload).toMatchObject({
      recovery: { kind: "RETRY", previousAttemptId: root.attemptId },
      purpose: "APPLY",
      fence: "2",
    });
    expect(
      (
        await db!
          .select()
          .from(otaTargets)
          .where(eq(otaTargets.targetId, root.targetId))
      )[0]!.snapshot,
    ).toEqual(identity(old));
    await expect(request("ROLLBACK", key)).rejects.toMatchObject({
      reason: "IDEMPOTENCY_CONFLICT",
    });
  });
  it("does not let a concurrent second approval stop the approved recovery", async () => {
    expect((await request()).status).toBe("WAITING");
    expect((await request()).failureReason).toBe("RECOVERY_ACTIVE");
    expect(
      (
        await db!
          .select()
          .from(otaDeployments)
          .where(eq(otaDeployments.deploymentId, root.deploymentId))
      )[0]!.status,
    ).toBe("PAUSED");
  });
  it.each([
    "INVALID_SIGNATURE",
    "DIGEST_MISMATCH",
    "DOWNLOAD_REJECTED",
    "CAPACITY_EXCEEDED",
    "CLOCK_UNTRUSTED",
    "FENCE_CONFLICT",
  ])("does not retry forbidden failure %s", async (failureCode) => {
    await db!.delete(otaEvents).where(eq(otaEvents.attemptId, root.attemptId));
    await fact(
      {
        type: "PROGRESS",
        requestType: "APPLY_RELEASE",
        state: "FAILED",
        commandId: root.commandId,
        reason: failureCode,
        downloadedBytes: 256,
      },
      0,
    );
    await fact(
      {
        type: "STATE",
        state: "FAILED",
        queryCommandId: randomUUID(),
        running: { release: identity(old), bootId },
      },
      1,
    );
    expect((await request()).failureReason).toBe("RETRY_NOT_ALLOWLISTED");
    expect(await repository.tick()).toEqual([]);
    expect(
      await db!
        .select()
        .from(otaAttempts)
        .where(eq(otaAttempts.targetId, root.targetId)),
    ).toHaveLength(1);
  });
  it("does not reapply an UNCERTAIN attempt", async () => {
    await db!
      .update(otaAttempts)
      .set({ evaluationStatus: "UNCERTAIN" })
      .where(eq(otaAttempts.attemptId, root.attemptId));
    expect((await request()).failureReason).toBe(
      "PREVIOUS_ATTEMPT_UNCONFIRMED",
    );
  });
  it("requires direct terminal evidence instead of assuming stopped after a failed delivery", async () => {
    await db!.execute(
      sql`DELETE FROM ota_events WHERE attempt_id=${root.attemptId} AND payload->>'type'='STATE'`,
    );
    expect((await request()).failureReason).toBe("STOP_UNCONFIRMED");
  });
  it("does not start with health at the exact freshness boundary", async () => {
    now = new Date(now.getTime() + 15000);
    expect((await request()).failureReason).toBe(
      "RECOVERY_OBSERVATION_MISSING",
    );
  });
  it("does not start with a failed readiness check", async () => {
    await inventory(old, 256, { ...ready, sqlite: "FAILED" });
    expect((await request()).failureReason).toBe("HEALTH_UNCONFIRMED");
  });
  it("hands an in-flight recovery to stop processing when another target stops the deployment", async () => {
    const { sends } = await releaseRetry();
    expect(sends).toHaveLength(1);
    await db!
      .update(otaDeployments)
      .set({ status: "WAITING_FOR_HUMAN" })
      .where(eq(otaDeployments.deploymentId, root.deploymentId));
    expect(await repository.tick()).toEqual([]);
    expect((await db!.select().from(otaRecoveries))[0]).toMatchObject({
      status: "RUNNING",
      finishedAt: null,
    });
    const stops = await createOtaRollout(db!, { clock: () => now }).tick();
    expect(stops).toHaveLength(1);
    expect(JSON.parse(stops[0]!.payload).type).toBe("STOP_UPDATE");
    expect((await db!.select().from(otaRecoveries))[0]!.finishedAt).toBeNull();
  });
  it("rejects bytes and time budget exhaustion and leaves a human action with unknown cost", async () => {
    await inventory(old, 268435456);
    const rejected = await request();
    expect(rejected.failureReason).toBe("DOWNLOAD_BUDGET_EXCEEDED");
    const [r] = await db!.select().from(otaRecoveries);
    expect(r!.requiredAction).toBe("INSPECT_BACKUP_OR_REPLACE_DEVICE");
    expect(r!.cost).toBeNull();
  });
  it("revalidates time, boot, trust and capability again after waiting", async () => {
    const accepted = await request();
    now = new Date(now.getTime() + 30000);
    await inventory();
    validatorAvailable = false;
    expect(await repository.tick()).toEqual([]);
    expect(
      (
        await db!
          .select()
          .from(otaRecoveries)
          .where(eq(otaRecoveries.recoveryId, accepted.recoveryId as string))
      )[0],
    ).toMatchObject({ status: "UNAVAILABLE", startedAt: null });
  });
  it("stops a claimed recovery before publish and does not call it recovered", async () => {
    const { sends } = await releaseRetry();
    expect(sends).toHaveLength(1);
    await createOtaRollout(db!, { clock: () => now }).act(
      root.deploymentId,
      "stop",
      randomUUID(),
      "OPERATOR_STOP",
    );
    let count = 0;
    await repository.deliver(sends[0]!, async () => {
      count++;
    });
    expect(count).toBe(0);
    expect((await db!.select().from(otaRecoveries))[0]!.status).toBe(
      "CANCELLED",
    );
  });
  it("survives worker restart without extending budget or issuing a third attempt", async () => {
    const { accepted, sends } = await releaseRetry();
    expect(sends).toHaveLength(1);
    const before = (await db!.select().from(otaRecoveries))[0]!;
    const restarted = createOtaRecovery(db!, { clock: () => now });
    now = new Date(now.getTime() + 8000);
    const again = await restarted.tick();
    expect(again[0]!.payload).toBe(sends[0]!.payload);
    expect(
      (
        await restarted.request(
          root.deploymentId,
          root.targetId,
          randomUUID(),
          "RETRY",
          "APPROVE",
        )
      ).failureReason,
    ).toBe("RECOVERY_ACTIVE");
    expect(
      (
        await db!
          .select()
          .from(otaRecoveries)
          .where(eq(otaRecoveries.recoveryId, accepted.recoveryId as string))
      )[0]!.budgetDeadline,
    ).toEqual(before.budgetDeadline);
  });
  async function rollback() {
    await db!.delete(otaEvents).where(eq(otaEvents.attemptId, root.attemptId));
    await fact(
      {
        type: "PROGRESS",
        requestType: "APPLY_RELEASE",
        state: "FAILED",
        commandId: root.commandId,
        reason: "HEALTH_FAILED",
        downloadedBytes: 1000,
      },
      0,
    );
    await fact(
      {
        type: "STATE",
        state: "FAILED",
        queryCommandId: randomUUID(),
        running: { release: identity(next), bootId },
      },
      1,
    );
    await inventory(next, 1000);
    const accepted = await request("ROLLBACK");
    expect(accepted.status).toBe("WAITING");
    const [send] = await repository.tick();
    expect(send).toBeDefined();
    return {
      accepted,
      apply: otaRequestMessageSchema.parse(
        JSON.parse(send!.payload),
      ) as OtaApplyRequest,
    };
  }
  async function finish(apply: OtaApplyRequest) {
    const fixture = otaFixture(Date.parse(apply.createdAt));
    const events = fixture.events.map((e) => ({
      ...e,
      deviceId: apply.deviceId,
      deploymentId: apply.deploymentId,
      stageId: apply.stageId,
      targetId: apply.targetId,
      attemptId: apply.attemptId,
      applyCommandId: apply.commandId,
      fence: apply.fence,
      release: apply.release,
      ...(e.type === "PROGRESS" ? { commandId: apply.commandId } : {}),
      ...(e.type === "VERSION" || e.type === "HEALTH"
        ? { running: { release: apply.release, bootId: fixture.bootId } }
        : {}),
    }));
    for (let n = 0; n < events.length; n++) {
      const e = otaEventMessageSchema.parse(events[n]);
      now = fixture.rows[n]!.storedAt;
      if (e.type === "HEALTH") {
        const createdAt = new Date(Date.parse(e.measuredAt) - 100),
          expiresAt = new Date(createdAt.getTime() + 15000);
        const { purpose, recovery, ...base } = apply;
        void purpose;
        void recovery;
        const payload = otaRequestMessageSchema.parse({
          ...base,
          type: "QUERY_STATE",
          commandId: e.queryCommandId,
          applyCommandId: apply.commandId,
          challengeId: e.challengeId,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          resultDeadline: expiresAt.toISOString(),
        });
        await db!.insert(otaQueries).values({
          commandId: e.queryCommandId,
          attemptId: apply.attemptId,
          challengeId: e.challengeId,
          expectedBootId: fixture.bootId,
          expectedSupervisorBootId: fixture.supervisorBootId,
          payload,
          createdAt,
          expiresAt,
          nextAttemptAt: expiresAt,
          attempts: 1,
        });
      }
      await createOtaRepository(db!, { clock: () => now }).ingest(
        e,
        fixture.rows[n]!.receivedAt,
      );
    }
  }
  it("records rollback success separately from the original failure only after old-version health evidence", async () => {
    const { accepted, apply } = await rollback();
    expect(apply.purpose).toBe("ROLLBACK");
    expect(apply.release).toEqual(identity(old));
    const [r] = await db!.select().from(otaRecoveries);
    expect(r!.finishedAt).toBeNull();
    await finish(apply);
    const after = (
      await db!
        .select()
        .from(otaRecoveries)
        .where(eq(otaRecoveries.recoveryId, accepted.recoveryId as string))
    )[0]!;
    expect(after.status).toBe("SUCCEEDED");
    expect(after.finishedAt).not.toBeNull();
    expect(after.evidence.length).toBeGreaterThan(13);
    expect(
      (
        await db!
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.attemptId, root.attemptId))
      )[0]!.evaluationStatus,
    ).toBe("FAILED");
    expect(
      (
        await db!
          .select()
          .from(otaTargets)
          .where(eq(otaTargets.targetId, root.targetId))
      )[0]!.status,
    ).toBe("RECOVERED");
    expect(
      (await createDeploymentRepository(db!, {
        directory: "/unused",
        trustStorePath: "/unused",
      }).find(root.deploymentId, 1))!.recoveries[0]!.status,
    ).toBe("SUCCEEDED");
  });
  it("does not clear a deployment-wide stop when one retry later succeeds", async () => {
    const { sends } = await releaseRetry();
    const apply = otaRequestMessageSchema.parse(
      JSON.parse(sends[0]!.payload),
    ) as OtaApplyRequest;
    await db!
      .update(otaDeployments)
      .set({ status: "WAITING_FOR_HUMAN" })
      .where(eq(otaDeployments.deploymentId, root.deploymentId));
    await finish(apply);
    expect((await db!.select().from(otaRecoveries))[0]!.status).toBe(
      "SUCCEEDED",
    );
    expect(
      (
        await db!
          .select()
          .from(otaDeployments)
          .where(eq(otaDeployments.deploymentId, root.deploymentId))
      )[0]!.status,
    ).toBe("WAITING_FOR_HUMAN");
  });
  it("records rollback failure without recursive rollback or success by acceptance", async () => {
    const { apply } = await rollback();
    now = new Date(now.getTime() + 1000);
    const event = otaEventMessageSchema.parse({
      schemaVersion: 1,
      deviceId: apply.deviceId,
      deploymentId: apply.deploymentId,
      stageId: apply.stageId,
      targetId: apply.targetId,
      attemptId: apply.attemptId,
      fence: apply.fence,
      release: apply.release,
      applyCommandId: apply.commandId,
      eventId: randomUUID(),
      sequence: 0,
      supervisorBootId,
      timestamp: now.toISOString(),
      type: "PROGRESS",
      requestType: "APPLY_RELEASE",
      commandId: apply.commandId,
      state: "FAILED",
      reason: "HEALTH_FAILED",
      downloadedBytes: 0,
    });
    await createOtaRepository(db!, { clock: () => now }).ingest(event, now);
    const [r] = await db!.select().from(otaRecoveries);
    expect(r!.status).toBe("FAILED");
    expect(r!.finishedAt).not.toBeNull();
    expect((await request("ROLLBACK")).status).toBe("UNAVAILABLE");
    expect(
      await db!
        .select()
        .from(otaAttempts)
        .where(eq(otaAttempts.targetId, root.targetId)),
    ).toHaveLength(2);
  });
  it("records rollback unavailable for missing or revoked old artifacts", async () => {
    await db!.delete(otaEvents).where(eq(otaEvents.attemptId, root.attemptId));
    await fact(
      {
        type: "PROGRESS",
        requestType: "APPLY_RELEASE",
        state: "FAILED",
        commandId: root.commandId,
        reason: "HEALTH_FAILED",
        downloadedBytes: 1000,
      },
      0,
    );
    await fact(
      {
        type: "STATE",
        state: "FAILED",
        queryCommandId: randomUUID(),
        running: { release: identity(next), bootId },
      },
      1,
    );
    await inventory(next, 1000);
    validatorAvailable = false;
    expect((await request("ROLLBACK")).failureReason).toBe(
      "ROLLBACK_UNAVAILABLE",
    );
    expect(await repository.tick()).toEqual([]);
    expect(
      await db!
        .select()
        .from(otaAttempts)
        .where(eq(otaAttempts.targetId, root.targetId)),
    ).toHaveLength(1);
  });
  it("does not reset the 15 minute budget by approving after a long pause", async () => {
    now = new Date(now.getTime() + 301000);
    await inventory();
    const result = await request();
    expect(result.failureReason).toBe("RECOVERY_TIME_BUDGET_EXCEEDED");
    expect(result.detectedAt).not.toBe(now.toISOString());
  });
  it("rolls back the new attempt, fence and approval when audit persistence fails", async () => {
    await db!.execute(
      sql`CREATE FUNCTION issue172_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='deployment.recovery_requested' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`,
    );
    await db!.execute(
      sql`CREATE TRIGGER issue172_reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION issue172_reject_audit()`,
    );
    try {
      await expect(request()).rejects.toThrow();
      expect(await db!.select().from(otaRecoveries)).toHaveLength(0);
      expect(
        await db!
          .select()
          .from(otaAttempts)
          .where(eq(otaAttempts.targetId, root.targetId)),
      ).toHaveLength(1);
      expect(
        (
          await db!
            .select()
            .from(otaDeviceStates)
            .where(eq(otaDeviceStates.deviceId, root.deviceId))
        )[0]!.highestFence,
      ).toBe(1n);
    } finally {
      await db!.execute(sql`DROP TRIGGER issue172_reject_audit ON audit_logs`);
      await db!.execute(sql`DROP FUNCTION issue172_reject_audit()`);
    }
  });
  it("exposes idempotent recovery approval and recovery evidence through HTTP", async () => {
    const app = buildApi(
      createDeviceRepository(db!),
      createCommandService(createCommandRepository(db!)),
      {
        deploymentRepository: {
          ...createDeploymentRepository(db!, {
            directory: "/unused",
            trustStorePath: "/unused",
          }),
          recover: repository.request,
        },
      },
    );
    const url = `/deployments/${root.deploymentId}/targets/${root.targetId}/recover`;
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            payload: { kind: "RETRY", reason: "APPROVE" },
          })
        ).statusCode,
      ).toBe(400);
      const headers = { "Idempotency-Key": randomUUID() },
        payload = { kind: "RETRY", reason: "APPROVE" };
      const first = await app.inject({ method: "POST", url, headers, payload }),
        replay = await app.inject({ method: "POST", url, headers, payload });
      expect(first.statusCode).toBe(202);
      expect(replay.json()).toEqual(first.json());
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers,
            payload: { ...payload, kind: "ROLLBACK" },
          })
        ).statusCode,
      ).toBe(409);
      const detail = (
        await app.inject({ url: `/deployments/${root.deploymentId}` })
      ).json();
      expect(detail.recoveries[0]).toMatchObject({
        status: "WAITING",
        cost: null,
        previousAttemptId: root.attemptId,
        startedAt: null,
        finishedAt: null,
      });
    } finally {
      await app.close();
    }
  });
  it("does not accept a zeroed transfer budget or mutate an approved deadline", async () => {
    await inventory(old, 0);
    expect((await request()).failureReason).toBe("RECOVERY_BUDGET_REGRESSION");
  });
  it("protects recovery identity, original response and budget even from accidental DB updates", async () => {
    const accepted = await request();
    const [row] = await db!
      .select()
      .from(otaRecoveries)
      .where(eq(otaRecoveries.recoveryId, accepted.recoveryId as string));
    await expect(
      db!
        .update(otaRecoveries)
        .set({
          detectedAt: new Date(row!.detectedAt.getTime() + 1000),
          budgetDeadline: new Date(row!.budgetDeadline.getTime() + 1000),
        })
        .where(eq(otaRecoveries.recoveryId, row!.recoveryId)),
    ).rejects.toThrow();
    await expect(
      db!
        .update(otaRecoveries)
        .set({ response: { status: "SUCCEEDED" } })
        .where(eq(otaRecoveries.recoveryId, row!.recoveryId)),
    ).rejects.toThrow();
    expect(
      (
        await db!
          .select()
          .from(otaRecoveries)
          .where(eq(otaRecoveries.recoveryId, row!.recoveryId))
      )[0]!.status,
    ).toBe("WAITING");
  });
  it("uses the production signature/artifact/capability validator at approval and delayed dispatch", async () => {
    const directory = await realpath(
        await mkdtemp(join(tmpdir(), "ota-recovery-validator-")),
      ),
      trustStorePath = join(directory, "trust.json");
    try {
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
      await publishArtifact(
        directory,
        packBundle(Buffer.from("console.info('next');")),
      );
      const control = createDeploymentRecovery(
        db!,
        { directory, trustStorePath },
        () => now,
      );
      const accepted = await control.request(
        root.deploymentId,
        root.targetId,
        randomUUID(),
        "RETRY",
        "APPROVED",
      );
      expect(accepted.status).toBe("WAITING");
      now = new Date(now.getTime() + 60000);
      await inventory();
      const sends = await control.tick();
      expect(sends).toHaveLength(1);
      expect(JSON.parse(sends[0]!.payload).recovery.recoveryId).toBe(
        accepted.recoveryId,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
