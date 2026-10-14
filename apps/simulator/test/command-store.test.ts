import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { commandMessageSchema } from "@drone-fleet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandStore } from "../src/command-store.js";

const command = {
  schemaVersion: 2 as const,
  deviceId: "drone-001",
  commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
  type: "RETURN_HOME" as const,
  timestamp: "2026-10-13T00:00:00.000Z",
  expiresAt: "2026-10-13T00:00:30.000Z",
};
let directory: string;
const stores: CommandStore[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "command-store-"));
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(directory, { recursive: true, force: true });
});
function open(
  options: {
    maxRows?: number;
    retentionMs?: number;
    clockTrusted?: boolean;
  } = {},
) {
  const store = new CommandStore("drone-001", {
    path: join(directory, "commands.sqlite"),
    ...options,
  });
  stores.push(store);
  return store;
}
function restart(store: CommandStore) {
  stores.splice(stores.indexOf(store), 1);
  store.close();
  return open();
}

describe("durable commands", () => {
  it("migrates old SQLite records without declaring legacy completion a new success", () => {
    const db = new DatabaseSync(join(directory, "commands.sqlite"));
    db.exec(
      "CREATE TABLE command_history (device_id TEXT, command_id TEXT, command_json TEXT, expires_at INTEGER, received_at TEXT, accepted_at TEXT, state TEXT, started_at TEXT, processed_at TEXT, ack_json TEXT, ack_pending INTEGER DEFAULT 1, PRIMARY KEY(device_id, command_id))",
    );
    const ack = {
      schemaVersion: 2,
      deviceId: command.deviceId,
      commandId: command.commandId,
      status: "ACKNOWLEDGED",
      timestamp: command.timestamp,
    };
    db.prepare(
      "INSERT INTO command_history VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, 1)",
    ).run(
      command.deviceId,
      command.commandId,
      JSON.stringify(commandMessageSchema.parse(command)),
      Date.parse(command.expiresAt),
      command.timestamp,
      command.timestamp,
      command.timestamp,
      command.timestamp,
      JSON.stringify(ack),
    );
    db.close();
    const store = open();
    expect(store.pendingExecutions()).toEqual([]);
    expect(store.pendingAcknowledgements()).toEqual([ack]);
    expect(
      store.receive(command, "2026-10-13T00:00:01.000Z")?.action,
    ).toBeNull();
  });
  it("does not let a PUBACK for the same payload clear a later redelivery request", () => {
    const store = open();
    store.receive(command, command.timestamp);
    store.begin(command.commandId, command.timestamp);
    store.complete(command.commandId, command.timestamp);
    const previous = store.pendingExecutions()[0]!;
    store.receive(command, "2026-10-13T00:00:01.000Z");
    store.confirmAcknowledgement(previous);
    expect(store.pendingExecutions()).toHaveLength(1);
  });
  it("persists independent execution notifications and ignores a stale PUBACK", () => {
    let store = open();
    store.receive(command, command.timestamp);
    store.begin(command.commandId, command.timestamp);
    const running = store.pendingExecutions()[0]!;
    expect(running.status).toBe("RUNNING");
    store.complete(command.commandId, "2026-10-13T00:00:10.000Z");
    store.confirmAcknowledgement(running);
    expect(store.pendingExecutions()[0]?.status).toBe("SUCCEEDED");
    store = restart(store);
    const result = store.pendingExecutions()[0]!;
    expect(result.status).toBe("SUCCEEDED");
    store.confirmAcknowledgement(result);
    expect(store.pendingExecutions()).toEqual([]);
    expect(
      store.receive(command, "2026-10-13T00:00:11.000Z")?.action,
    ).toBeNull();
    expect(store.pendingExecutions()).toEqual([result]);
  });
  it("notifies UNCERTAIN after interruption and never resumes a started command", () => {
    let store = open();
    store.receive(command, command.timestamp);
    store.begin(command.commandId, command.timestamp);
    store = restart(store);
    expect(store.pendingExecutions()[0]?.status).toBe("UNCERTAIN");
    expect(store.history()[0]?.processed_at).toBeNull();
    expect(store.recover("2026-10-13T00:00:02.000Z")).toEqual([]);
    expect(
      store.receive(command, "2026-10-13T00:00:02.000Z")?.action,
    ).toBeNull();
  });
  it("records explicit execution failures without changing the accepted receipt", () => {
    const store = open();
    const received = store.receive(command, command.timestamp)!;
    store.begin(command.commandId, command.timestamp);
    store.finish(command.commandId, "2026-10-13T00:00:01.000Z", "FAILED");
    expect(store.pendingExecutions()[0]?.status).toBe("FAILED");
    expect(store.pendingAcknowledgements()).toEqual([received.acknowledgement]);
    expect(
      store.receive(command, "2026-10-13T00:00:02.000Z")?.action,
    ).toBeNull();
  });
  it("does not repeat completed actions across restart and republishes the stored acknowledgement", () => {
    let store = open();
    const received = store.receive(command, command.timestamp)!;
    expect(store.begin(command.commandId, command.timestamp)?.action).toBe(
      "RETURN_HOME",
    );
    store.complete(command.commandId, command.timestamp);
    store.confirmAcknowledgement(received.acknowledgement);
    store = restart(store);
    const duplicate = store.receive(command, "2026-10-13T00:00:01.000Z")!;
    expect(duplicate.action).toBeNull();
    expect(duplicate.acknowledgement).toEqual(received.acknowledgement);
    expect(store.pendingAcknowledgements()).toEqual([received.acknowledgement]);
  });
  it.each(["2026-10-13T00:00:30.000Z", "2026-10-13T00:00:30.001Z"])(
    "rejects expiration at %s",
    (now) => {
      const store = open();
      const result = store.receive(command, now)!;
      expect(result.action).toBeNull();
      expect(result.acknowledgement.status).toBe("REJECTED_EXPIRED");
    },
  );
  it("rechecks expiry before starting and retains acceptance history across restart", () => {
    let store = open();
    store.receive(command, "2026-10-13T00:00:29.999Z");
    store = restart(store);
    const recovered = store.recover(command.expiresAt)[0]!;
    const expired = store.begin(
      recovered.acknowledgement.commandId,
      command.expiresAt,
    )!;
    expect(expired.action).toBeNull();
    expect(expired.acknowledgement.status).toBe("REJECTED_EXPIRED");
    expect(store.history()[0]).toMatchObject({
      state: "EXPIRED",
      accepted_at: "2026-10-13T00:00:29.999Z",
    });
  });
  it("resumes receipt-only records before expiry but does not replay a started action after a crash", () => {
    let store = open();
    store.receive(command, command.timestamp);
    store = restart(store);
    const pending = store.recover("2026-10-13T00:00:01.000Z")[0]!;
    expect(
      store.begin(pending.acknowledgement.commandId, "2026-10-13T00:00:01.000Z")
        ?.action,
    ).toBe("RETURN_HOME");
    store = restart(store);
    expect(store.recover("2026-10-13T00:00:02.000Z")).toEqual([]);
    expect(
      store.receive(command, "2026-10-13T00:00:02.000Z")?.action,
    ).toBeNull();
    expect(store.history()[0]?.state).toBe("UNCERTAIN");
  });
  it("does not let a late PUBACK clear a newer expiration ACK", () => {
    const store = open();
    const original = store.receive(command, command.timestamp)!;
    store.begin(command.commandId, command.expiresAt);
    store.confirmAcknowledgement(original.acknowledgement);
    expect(store.pendingAcknowledgements()[0]?.status).toBe("REJECTED_EXPIRED");
  });
  it("rejects conflicts, an untrusted clock, and backwards time without starting an action", () => {
    const store = open();
    store.receive(command, "2026-10-13T00:00:01.000Z");
    expect(() =>
      store.receive({ ...command, type: "REBOOT" }, "2026-10-13T00:00:01.000Z"),
    ).toThrow("conflict");
    expect(() => store.begin(command.commandId, command.timestamp)).toThrow(
      "clock",
    );
    expect(() =>
      open({ clockTrusted: false }).receive(command, command.timestamp),
    ).toThrow("clock");
  });
  it("keeps unexpired history at capacity and only evicts expired rows", () => {
    const store = open({ maxRows: 1 });
    store.receive(command, command.timestamp);
    store.begin(command.commandId, command.timestamp);
    store.complete(command.commandId, command.timestamp);
    const next = {
      ...command,
      commandId: "6c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
      expiresAt: "2026-10-13T00:01:00.000Z",
    };
    expect(() => store.receive(next, command.timestamp)).toThrow("full");
    expect(store.receive(next, command.expiresAt)?.action).toBe("RETURN_HOME");
    expect(store.history()).toHaveLength(1);
    expect(() => store.receive(command, command.expiresAt)).toThrow("full");
  });
  it("prunes old history according to retention on subsequent reception", () => {
    const store = open({ retentionMs: 1000 });
    store.receive(command, command.expiresAt);
    store.receive(
      {
        ...command,
        commandId: "6c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
        expiresAt: "2026-10-13T00:01:00.000Z",
      },
      "2026-10-13T00:00:31.000Z",
    );
    expect(store.history()).toHaveLength(1);
  });
});
