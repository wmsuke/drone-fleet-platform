import type { TelemetryMessage } from "@drone-fleet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TelemetryBatchWriter,
  TelemetryBufferFullError,
} from "../src/batch-writer.js";
import type { TelemetryRepository } from "../src/repository.js";

const message = (sequence: number): TelemetryMessage => ({
  schemaVersion: 1,
  deviceId: "drone-001",
  sequence,
  timestamp: "2026-10-02T00:00:00.000Z",
  payload: {
    battery: 80,
    latitude: 35,
    longitude: 139,
    altitude: 10,
    temperature: 25,
    status: "FLYING",
  },
});

describe("TelemetryBatchWriter", () => {
  it("persists the next save immediately after the previous result resolves", async () => {
    const writer = new TelemetryBatchWriter(
      { saveBatch: async (entries) => entries.map(() => "saved") },
      {
        batchSize: 1,
        flushIntervalMs: 50,
        maxBufferSize: 10,
      },
    );
    expect(await writer.save(message(0), new Date())).toBe("saved");
    expect(await writer.save(message(1), new Date())).toBe("saved");
    await writer.shutdown();
  });
  it("returns each committed result independently in a mixed batch", async () => {
    const writer = new TelemetryBatchWriter(
      { saveBatch: async () => ["saved", "duplicate", "conflict"] },
      {
        batchSize: 3,
        flushIntervalMs: 50,
        maxBufferSize: 10,
      },
    );
    expect(
      await Promise.all([
        writer.save(message(0), new Date()),
        writer.save(message(1), new Date()),
        writer.save(message(2), new Date()),
      ]),
    ).toEqual(["saved", "duplicate", "conflict"]);
    await writer.shutdown();
  });
  afterEach(() => vi.useRealTimers());

  it("flushes when the batch size is reached", async () => {
    const repository: TelemetryRepository = {
      saveBatch: vi.fn(async (entries) => entries.map(() => "saved" as const)),
    };
    const writer = new TelemetryBatchWriter(repository, {
      batchSize: 2,
      flushIntervalMs: 1_000,
      maxBufferSize: 10,
    });
    const receivedAt = new Date("2026-10-02T00:00:01.000Z");

    const first = writer.save(message(1), receivedAt);
    const second = writer.save(message(2), receivedAt, true);
    await Promise.all([first, second]);

    expect(repository.saveBatch).toHaveBeenCalledWith([
      { message: message(1), receivedAt, isRetained: false },
      { message: message(2), receivedAt, isRetained: true },
    ]);
  });

  it("flushes after the configured interval", async () => {
    vi.useFakeTimers();
    const repository: TelemetryRepository = {
      saveBatch: vi.fn(async (entries) => entries.map(() => "saved" as const)),
    };
    const writer = new TelemetryBatchWriter(repository, {
      batchSize: 10,
      flushIntervalMs: 50,
      maxBufferSize: 10,
    });
    const saving = writer.save(message(1), new Date());

    await vi.advanceTimersByTimeAsync(49);
    expect(repository.saveBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await saving;

    expect(repository.saveBatch).toHaveBeenCalledOnce();
  });

  it("rejects every message when a batch fails", async () => {
    const error = new Error("database unavailable");
    const repository: TelemetryRepository = {
      saveBatch: vi.fn().mockRejectedValue(error),
    };
    const writer = new TelemetryBatchWriter(repository, {
      batchSize: 2,
      flushIntervalMs: 1_000,
      maxBufferSize: 10,
    });

    const first = writer.save(message(1), new Date());
    const second = writer.save(message(2), new Date());

    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
  });

  it("rejects new messages while the bounded buffer is full", async () => {
    let finishBatch = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      finishBatch = resolve;
    });
    const repository: TelemetryRepository = {
      saveBatch: async () => {
        await blocked;
        return ["saved"];
      },
    };
    const writer = new TelemetryBatchWriter(repository, {
      batchSize: 1,
      flushIntervalMs: 1_000,
      maxBufferSize: 1,
    });

    const first = writer.save(message(1), new Date());
    await expect(writer.save(message(2), new Date())).rejects.toBeInstanceOf(
      TelemetryBufferFullError,
    );

    finishBatch();
    await first;
  });

  it("flushes the remaining buffer during shutdown", async () => {
    const repository: TelemetryRepository = {
      saveBatch: vi.fn(async (entries) => entries.map(() => "saved" as const)),
    };
    const writer = new TelemetryBatchWriter(repository, {
      batchSize: 10,
      flushIntervalMs: 1_000,
      maxBufferSize: 10,
    });
    const saving = writer.save(message(1), new Date());

    await writer.shutdown();
    await saving;

    expect(repository.saveBatch).toHaveBeenCalledOnce();
    await expect(writer.save(message(2), new Date())).rejects.toThrow(
      "telemetry batch writer is stopped",
    );
  });
});
