import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { packBundle } from "@drone-fleet/releases";
import { Journal } from "../src/journal.js";
import { permittedAddress, validateSource } from "../src/artifacts.js";
import { makeEnvelope, applyRequest } from "./support.js";
import { fixture } from "./support.js";
import { fetchBytes } from "../src/artifacts.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("OTA journal persistence", () => {
  it("keeps recovery bytes, original deadline and retry/rollback limits after reopening SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ota-recovery-journal-"));
    roots.push(directory);
    const path = join(directory, "journal.sqlite"),
      envelope = makeEnvelope(
        packBundle(Buffer.from("console.info('budget');")),
      );
    let journal = new Journal(path);
    journal.initialize("ota-test", envelope);
    const root = applyRequest(envelope);
    journal.transaction(() => {
      journal.authorize(root);
      journal.remember(root);
      journal.change(
        { apply: root, phase: "FAILED", highestFence: "1" },
        {
          type: "PROGRESS",
          requestType: "APPLY_RELEASE",
          commandId: root.commandId,
          state: "FAILED",
          reason: "DOWNLOAD_FAILED",
          downloadedBytes: 0,
        },
      );
    });
    journal.failure(root.targetId);
    journal.accountBytes(root.targetId, 100);
    const original = journal.budget(root.targetId)!;
    journal.close();
    journal = new Journal(path);
    const issuedAt = Date.now();
    const retry = {
      ...root,
      createdAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 300000).toISOString(),
      resultDeadline: new Date(issuedAt + 600000).toISOString(),
      attemptId: randomUUID(),
      commandId: randomUUID(),
      fence: "2",
      recovery: {
        recoveryId: randomUUID(),
        previousAttemptId: root.attemptId,
        rootAttemptId: root.attemptId,
        kind: "RETRY" as const,
        detectedAt: original.detected_at!,
        budgetDeadline: original.deadline!,
        maxDownloadBytes: 268435456 as const,
      },
    };
    journal.transaction(() => {
      journal.authorize(retry);
      journal.remember(retry);
      journal.change({ apply: retry, phase: "FAILED", highestFence: "2" });
    });
    journal.failure(root.targetId);
    journal.accountBytes(root.targetId, 50);
    journal.close();
    journal = new Journal(path);
    expect(journal.budget(root.targetId)).toMatchObject({
      bytes: 150,
      retry_used: 1,
      rollback_used: 0,
      deadline: original.deadline,
    });
    expect(() =>
      journal.authorize({
        ...retry,
        recovery: { ...retry.recovery, previousAttemptId: retry.attemptId },
      }),
    ).toThrow("CAPACITY_EXCEEDED");
    const rollback = {
      ...retry,
      attemptId: randomUUID(),
      commandId: randomUUID(),
      purpose: "ROLLBACK" as const,
      fence: "3",
      recovery: {
        ...retry.recovery,
        kind: "ROLLBACK" as const,
        previousAttemptId: retry.attemptId,
      },
    };
    journal.transaction(() => {
      journal.authorize(rollback);
      journal.remember(rollback);
      journal.change({ apply: rollback, highestFence: "3" });
    });
    expect(journal.budget(root.targetId)!.rollback_used).toBe(1);
    journal.accountBytes(root.targetId, 268435456 - 150);
    expect(() => journal.accountBytes(root.targetId, 1)).toThrow(
      "CAPACITY_EXCEEDED",
    );
    expect(journal.budget(root.targetId)!.bytes).toBe(268435457);
    journal.close();
  });
  it("persists the initial inventory independently and confirms only its exact hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "ota-inventory-"));
    roots.push(root);
    const path = join(root, "journal.sqlite"),
      envelope = makeEnvelope(
        packBundle(Buffer.from("console.info('inventory');")),
      );
    let journal = new Journal(path);
    journal.initialize("ota-test", envelope);
    const { releaseId, digest, version, buildId } = envelope.manifest;
    const timestamp = new Date().toISOString();
    const input = {
      schemaVersion: 1 as const,
      type: "INVENTORY" as const,
      deviceId: "ota-test",
      supervisorBootId: randomUUID(),
      timestamp,
      measuredAt: timestamp,
      sampleAgeMs: 0,
      running: {
        release: { releaseId, digest, version, buildId },
        bootId: randomUUID(),
      },
      capabilities: {
        application: "simulator" as const,
        platform: "linux-arm64" as const,
        nodeVersion: "22.13.0",
        otaProtocolVersion: "1.0.0" as const,
        supervisorVersion: "1.0.0" as const,
        stateSchemaVersion: "1.0.0" as const,
        healthContractVersion: "ota-health-v1" as const,
      },
    };
    journal.inventory(input);
    const pending = journal.pendingInventory()!;
    journal.close();
    journal = new Journal(path);
    expect(journal.pendingInventory()).toEqual(pending);
    const event = JSON.parse(pending.json);
    const receipt = {
      schemaVersion: 1,
      type: "INVENTORY",
      deviceId: "ota-test",
      eventId: event.eventId,
      payloadHash: pending.hash,
      status: "STORED",
      receivedAt: timestamp,
      storedAt: timestamp,
    };
    expect(
      journal.confirmInventory({ ...receipt, payloadHash: "0".repeat(64) }),
    ).toBe(false);
    expect(journal.confirmInventory(receipt)).toBe(true);
    expect(journal.pending()).toBeUndefined();
    journal.inventory(input);
    expect(JSON.parse(journal.pendingInventory()!.json).sequence).toBe(
      event.sequence + 1,
    );
    journal.close();
  });
  it("persists identity/fence/events; PUBACK does not confirm and wrong receipt cannot clear the event", async () => {
    const root = await mkdtemp(join(tmpdir(), "ota-journal-"));
    roots.push(root);
    const path = join(root, "journal.sqlite");
    const envelope = makeEnvelope(
      packBundle(Buffer.from("console.info('journal');")),
    );
    const request = applyRequest(envelope);
    let journal = new Journal(path);
    journal.initialize("ota-test", envelope);
    journal.transaction(() => {
      journal.remember(request);
      journal.change(
        { apply: request, highestFence: "1", phase: "RECEIVED" },
        {
          type: "PROGRESS",
          requestType: "APPLY_RELEASE",
          state: "RECEIVED",
          commandId: request.commandId,
          downloadedBytes: 0,
          reason: null,
        },
      );
    });
    const pending = journal.pending()!;
    expect(pending).toBeDefined();
    expect(() => journal.remember({ ...request, purpose: "ROLLBACK" })).toThrow(
      "COMMAND_CONFLICT",
    );
    journal.close();
    journal = new Journal(path);
    expect(journal.read()).toMatchObject({
      highestFence: "1",
      phase: "RECEIVED",
    });
    expect(journal.replay(request)).toBe(true);
    expect(journal.pending()).toEqual(pending);
    const event = JSON.parse(pending.json);
    const {
      schemaVersion,
      deviceId,
      deploymentId,
      stageId,
      targetId,
      attemptId,
      fence,
      release,
      eventId,
    } = event;
    const receipt = {
      schemaVersion,
      deviceId,
      deploymentId,
      stageId,
      targetId,
      attemptId,
      fence,
      release,
      eventId,
      payloadHash: pending.hash,
      status: "STORED",
      receivedAt: new Date().toISOString(),
      storedAt: new Date().toISOString(),
    };
    expect(pending.hash).toBe(
      createHash("sha256").update(pending.json).digest("hex"),
    );
    expect(journal.confirm({ ...receipt, fence: "2" })).toBe(false);
    expect(journal.confirm({ ...receipt, payloadHash: "0".repeat(64) })).toBe(
      false,
    );
    expect(journal.confirm(receipt)).toBe(true);
    expect(journal.pending()).toBeUndefined();
    expect(journal.events()).toHaveLength(1);
    journal.close();
  });
  it("rolls back a request and state together if recording fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ota-journal-"));
    roots.push(root);
    const journal = new Journal(join(root, "journal.sqlite"));
    const envelope = makeEnvelope(
      packBundle(Buffer.from("console.info('journal');")),
    );
    const request = applyRequest(envelope);
    journal.initialize("ota-test", envelope);
    expect(() =>
      journal.transaction(() => {
        journal.remember(request);
        journal.change({ highestFence: "1" });
        throw new Error("crash");
      }),
    ).toThrow();
    expect(journal.read().highestFence).toBe("0");
    expect(journal.replay(request)).toBe(false);
    journal.close();
  });
});
describe("fixed-origin connection allowlist", () => {
  it("does not follow redirects and bounds received bytes", async () => {
    const f = await fixture();
    try {
      f.server.removeAllListeners("request");
      let hits = 0;
      f.server.on("request", (_req, res) => {
        hits++;
        res.writeHead(302, { Location: "http://169.254.169.254/" }).end();
      });
      await expect(
        fetchBytes(
          f.config.metadataSource,
          `/releases/${f.baseline.manifest.releaseId}`,
          1024,
          AbortSignal.timeout(2000),
        ),
      ).rejects.toThrow("DOWNLOAD_REJECTED");
      expect(hits).toBe(1);
      f.server.removeAllListeners("request");
      f.server.on("request", (_req, res) => res.end(Buffer.alloc(2048)));
      await expect(
        fetchBytes(
          f.config.metadataSource,
          `/releases/${f.baseline.manifest.releaseId}`,
          1024,
          AbortSignal.timeout(2000),
        ),
      ).rejects.toThrow("SIZE_MISMATCH");
    } finally {
      await new Promise<void>((resolve) => f.server.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each([
    "http://127.0.0.1/path",
    "http://user:pass@127.0.0.1",
    "http://127.0.0.1?key=secret",
    "http://169.254.169.254",
    "http://8.8.8.8",
  ])("rejects %s", (origin) =>
    expect(() =>
      validateSource({
        origin,
        allowedCidrs: ["127.0.0.1/32"],
        localHttp: true,
      }),
    ).toThrow(),
  );
  it("restricts IPs and does not silently enable insecure HTTP", () => {
    expect(permittedAddress("127.0.0.1", ["127.0.0.1/32"])).toBe(true);
    expect(permittedAddress("169.254.169.254", ["172.16.0.0/12"])).toBe(false);
    expect(permittedAddress("::1", ["127.0.0.1/32"])).toBe(false);
    expect(() =>
      validateSource({
        origin: "http://127.0.0.1",
        allowedCidrs: ["127.0.0.1/32"],
        localHttp: false,
      }),
    ).toThrow();
  });
});
