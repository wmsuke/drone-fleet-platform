import { createTelemetryMessage } from "../src/messages.js";
import { TelemetryBuffer } from "../src/telemetry-buffer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const sessionId = "a065e32b-c00b-452e-9cb1-3b52c43962fb";
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "drone-fleet-buffer-test-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function message(sequence: number, deviceId = "drone-001") {
  return createTelemetryMessage(
    deviceId,
    sessionId,
    sequence,
    "2026-10-07T00:00:00.000Z",
  );
}

function openBuffer(maxRows = 10_000, maxBytes = 32 * 1024 * 1024) {
  return new TelemetryBuffer(join(directory, "drone-001.sqlite"), "drone-001", {
    maxRows,
    maxBytes,
  });
}

describe("TelemetryBuffer", () => {
  it("creates the schema, retains order and exact payload after reopening", () => {
    const buffer = openBuffer();
    buffer.append(message(0));
    buffer.append(message(1));
    buffer.markAttempted(sessionId, 0, "2026-10-07T00:00:01.000Z");
    buffer.markPublished(sessionId, 0, "2026-10-07T00:00:02.000Z");
    buffer.close();

    const reopened = openBuffer();
    const rows = reopened.listUnconfirmed();
    expect(rows.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({
      sessionId,
      attemptCount: 1,
      lastAttemptAt: "2026-10-07T00:00:01.000Z",
      publishedAt: "2026-10-07T00:00:02.000Z",
    });
    expect(JSON.parse(rows[0]?.payloadJson ?? "")).toEqual(message(0));
    expect(reopened.stats()).toMatchObject({ rows: 2, discarded: 0 });
    expect(reopened.peekPendingPublish()?.sequence).toBe(0);
    expect(reopened.brokerAcknowledgedCount()).toBe(1);
    expect(reopened.pendingPublishStats()).toEqual({
      count: 2,
      oldestCreatedAt: message(0).timestamp,
    });
    expect(reopened.confirmStored(sessionId, 0)).toBe(true);
    expect(reopened.listUnconfirmed()).toHaveLength(1);
    reopened.close();
  });

  it("migrates a version-one buffer without losing its rows", () => {
    const path = join(directory, "drone-001.sqlite");
    const original = openBuffer();
    original.append(message(7));
    original.close();
    const previous = new DatabaseSync(path);
    previous.exec(
      "DROP INDEX telemetry_buffer_pending_idx; PRAGMA user_version=1",
    );
    previous.close();

    const migrated = openBuffer();
    expect(migrated.peekPendingPublish()?.sequence).toBe(7);
    expect(migrated.pendingPublishStats().count).toBe(1);
    migrated.close();
  });

  it("migrates an empty version-zero database and rejects a newer schema", () => {
    const path = join(directory, "drone-001.sqlite");
    const previous = new DatabaseSync(path);
    expect(
      (
        previous.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(0);
    previous.close();

    const buffer = openBuffer();
    buffer.append(message(0));
    buffer.close();

    const newer = new DatabaseSync(path);
    expect(
      (newer.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(2);
    newer.exec("PRAGMA user_version=3");
    newer.close();
    expect(() => openBuffer()).toThrow(
      "unsupported telemetry buffer schema version: 3",
    );
  });

  it("evicts the oldest unconfirmed row and records the affected identity", () => {
    const buffer = openBuffer(2);
    buffer.append(message(0));
    buffer.append(message(1));
    const result = buffer.append(message(2));

    expect(buffer.listUnconfirmed().map(({ sequence }) => sequence)).toEqual([
      1, 2,
    ]);
    expect(result.discard).toMatchObject({
      count: 1,
      firstSessionId: sessionId,
      firstSequence: 0,
      lastSessionId: sessionId,
      lastSequence: 0,
      reason: "ROW_LIMIT",
    });
    expect(buffer.listDiscards()).toEqual([result.discard]);
    expect(buffer.stats().discarded).toBe(1);
    buffer.close();
  });

  it("enforces UTF-8 JSON byte limits and records oversized samples", () => {
    const bytes = Buffer.byteLength(JSON.stringify(message(0)), "utf8");
    const maxBytes =
      Math.max(
        ...[0, 1, 2].map((sequence) =>
          Buffer.byteLength(JSON.stringify(message(sequence)), "utf8"),
        ),
      ) * 2;
    const buffer = openBuffer(10, maxBytes);
    buffer.append(message(0));
    buffer.append(message(1));
    expect(buffer.append(message(2)).discard?.reason).toBe("BYTE_LIMIT");
    expect(buffer.listUnconfirmed().map(({ sequence }) => sequence)).toEqual([
      1, 2,
    ]);
    buffer.close();

    const small = new TelemetryBuffer(
      join(directory, "small.sqlite"),
      "drone-001",
      {
        maxRows: 10,
        maxBytes: bytes - 1,
      },
    );
    expect(small.append(message(0))).toMatchObject({
      stored: false,
      discard: { count: 1, reason: "OVERSIZED", firstSequence: 0 },
    });
    expect(small.stats()).toEqual({ rows: 0, bytes: 0, discarded: 1 });
    small.close();
  });

  it("does not mix different device IDs", () => {
    const buffer = openBuffer();
    expect(() => buffer.append(message(0, "drone-002"))).toThrow(
      "telemetry deviceId does not match buffer deviceId",
    );
    expect(buffer.stats().rows).toBe(0);
    buffer.close();
  });
});
