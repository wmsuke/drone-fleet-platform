import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { createDatabase, releases, auditLogs } from "@drone-fleet/database";
import {
  canonical,
  digestOf,
  packBundle,
  publishArtifact,
  type Manifest,
} from "@drone-fleet/releases";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandRepository } from "../src/command-repository.js";
import { createCommandService } from "../src/command-service.js";
import { createReleaseRepository } from "../src/release-repository.js";
import { createAuditQueryRepository } from "../src/audit-query-repository.js";

const enabled = process.env.DATABASE_INTEGRATION === "true";
describe.skipIf(!enabled)("release registration API with PostgreSQL", () => {
  const database = enabled ? createDatabase() : undefined;
  function configured() {
    if (!database) throw new Error("integration disabled");
    return database;
  }
  const pair = generateKeyPairSync("ed25519");
  let root: string;
  let trust: string;
  const archive = packBundle(Buffer.from('console.info("release 1");'));
  const manifest = (): Manifest => ({
    schemaVersion: 1,
    releaseId: randomUUID(),
    application: "simulator",
    version: `0.0.0-test.${randomUUID()}`,
    buildId: "integration",
    platform: "linux-arm64",
    nodeRange: ">=22.13.0 <23",
    otaProtocolRange: "^1.0.0",
    supervisorRange: "^1.0.0",
    stateSchemaRange: "1.0.0",
    digest: digestOf(archive),
    size: archive.length,
    entrypoint: "app/main.mjs",
    healthContractVersion: "ota-health-v1",
    rollbackCompatible: true,
  });
  function payload(m: Manifest) {
    return canonical({
      manifest: m,
      keyId: "test",
      algorithm: "Ed25519",
      signature: sign(
        null,
        Buffer.from(canonical(m)),
        pair.privateKey,
      ).toString("base64"),
    });
  }
  function api() {
    const { db } = configured();
    return buildApi(
      createDeviceRepository(db),
      createCommandService(createCommandRepository(db)),
      {
        auditDatabase: db,
        auditQueryRepository: createAuditQueryRepository(db),
        releases: {
          repository: createReleaseRepository(db),
          directory: root,
          trustStorePath: trust,
        },
      },
    );
  }
  beforeAll(async () => {
    await migrate(configured().db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    root = await realpath(await mkdtemp(join(tmpdir(), "release-api-test-")));
    trust = join(root, "trust-store.json");
    await writeFile(
      trust,
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
    await publishArtifact(root, archive);
  });
  afterAll(async () => {
    // releaseは不変のためtestでも削除しない。専用検証DBを破棄する。
    await configured().client.end();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("registers, reads and audits VERIFIED metadata atomically; identical retries keep one row/audit", async () => {
    const app = api();
    const m = manifest();
    try {
      const post = () =>
        app.inject({
          method: "POST",
          url: "/releases",
          headers: {
            "content-type": "application/json",
            "x-actor-id": "untrusted",
          },
          payload: payload(m),
        });
      const results = await Promise.all([post(), post()]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
      expect(results[0]!.json()).toMatchObject({
        releaseId: m.releaseId,
        verification: "VERIFIED",
        actorKind: "anonymous",
        actorId: null,
        envelope: { manifest: m },
        artifactPath: `/objects/${m.digest}.tar.gz`,
      });
      const get = await app.inject(`/releases/${m.releaseId}`);
      expect(get.statusCode).toBe(200);
      expect((await app.inject("/releases")).json().items).toContainEqual(
        get.json(),
      );
      const logs = await configured()
        .db.select()
        .from(auditLogs)
        .where(eq(auditLogs.targetId, m.releaseId));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "release.registered",
        actorKind: "anonymous",
        actorId: null,
        result: "SUCCEEDED",
        metadata: { afterStatus: "VERIFIED" },
      });
      const audit = await app.inject(
        `/audit-logs?action=release.registered&targetKind=release&targetId=${m.releaseId}`,
      );
      expect(audit.statusCode).toBe(200);
      expect(audit.json().items).toHaveLength(1);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/releases/${m.releaseId}`,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("rejects changed releaseId/version identity, concurrent version conflicts and preserves original content", async () => {
    const app = api();
    const m = manifest();
    const post = (input: Manifest) =>
      app.inject({
        method: "POST",
        url: "/releases",
        headers: { "content-type": "application/json" },
        payload: payload(input),
      });
    try {
      expect((await post(m)).statusCode).toBe(201);
      expect((await post({ ...m, buildId: "changed" })).statusCode).toBe(409);
      expect((await post({ ...m, releaseId: randomUUID() })).statusCode).toBe(
        409,
      );
      expect(
        (await app.inject(`/releases/${m.releaseId}`)).json().envelope.manifest,
      ).toEqual(m);
      const fresh = manifest();
      const concurrent = await Promise.all([
        post(fresh),
        post({ ...fresh, releaseId: randomUUID() }),
      ]);
      expect(concurrent.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    } finally {
      await app.close();
    }
  });
  it("detects malformed signatures/digest/size/compatibility; rejected input is not persisted or echoed into audit", async () => {
    const app = api();
    try {
      const m = manifest();
      const inputs = [
        payload({ ...m, size: m.size + 1 }),
        payload({ ...m, digest: "0".repeat(64) }),
        payload({ ...m, stateSchemaRange: "^2.0.0" }),
        payload(m).replace(
          /"signature":"[^"]+"/,
          `"signature":"${Buffer.alloc(64).toString("base64")}"`,
        ),
        payload(m).replace('"keyId":"test"', '"keyId":"unknown"'),
        payload(m) + "\n",
        JSON.stringify({
          url: "http://169.254.169.254/latest/meta-data/",
          privateKey: "never-record-this",
        }),
      ];
      for (const input of inputs) {
        const response = await app.inject({
          method: "POST",
          url: "/releases",
          headers: { "content-type": "application/json" },
          payload: input,
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(500);
        const [log] = await configured()
          .db.select()
          .from(auditLogs)
          .where(
            eq(auditLogs.requestId, response.headers["x-request-id"] as string),
          );
        expect(log).toMatchObject({
          action: "release.registered",
          result: "REJECTED",
        });
        expect(JSON.stringify(log)).not.toContain("never-record-this");
        expect(JSON.stringify(log)).not.toContain("169.254");
      }
      expect(
        await configured()
          .db.select()
          .from(releases)
          .where(eq(releases.releaseId, m.releaseId)),
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it("DB rejects UPDATE/DELETE/TRUNCATE even when a downstream reference exists", async () => {
    const { db } = configured();
    const m = manifest();
    const app = api();
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/releases",
            headers: { "content-type": "application/json" },
            payload: payload(m),
          })
        ).statusCode,
      ).toBe(201);
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMP TABLE release_reference_test (release_id uuid REFERENCES releases(release_id) ON DELETE RESTRICT) ON COMMIT DROP`,
          );
          await tx.execute(
            sql`INSERT INTO release_reference_test VALUES (${m.releaseId})`,
          );
          await tx.delete(releases).where(eq(releases.releaseId, m.releaseId));
        }),
      ).rejects.toThrow();
      await expect(
        db
          .update(releases)
          .set({ version: "9.0.0" })
          .where(eq(releases.releaseId, m.releaseId)),
      ).rejects.toThrow();
      await expect(
        db.delete(releases).where(eq(releases.releaseId, m.releaseId)),
      ).rejects.toThrow();
      await expect(db.execute(sql`TRUNCATE releases`)).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
  it("rolls registration back when the success audit fails", async () => {
    const { db } = configured();
    const m = manifest();
    await db.execute(
      sql`CREATE FUNCTION issue166_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER issue166_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action='release.registered' AND NEW.result='SUCCEEDED') EXECUTE FUNCTION issue166_fail_audit()`,
    );
    const app = api();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/releases",
        headers: { "content-type": "application/json" },
        payload: payload(m),
      });
      expect(response.statusCode).toBe(503);
      expect(
        await db
          .select()
          .from(releases)
          .where(eq(releases.releaseId, m.releaseId)),
      ).toEqual([]);
    } finally {
      await app.close();
      await db.execute(sql`DROP TRIGGER issue166_fail_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION issue166_fail_audit()`);
    }
  });
});
