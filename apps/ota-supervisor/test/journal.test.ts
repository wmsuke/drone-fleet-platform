import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
      ).rejects.toThrow("DOWNLOAD_FAILED");
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
