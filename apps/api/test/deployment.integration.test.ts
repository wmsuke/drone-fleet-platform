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
