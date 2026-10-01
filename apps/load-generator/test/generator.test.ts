import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoadGeneratorConfig } from "../src/config.js";
import {
  createLoadDeviceIds,
  runLoadGenerator,
  type LoadGeneratorMqttClient,
} from "../src/generator.js";
import type { LoadGeneratorReport } from "../src/report.js";

function createConfig(
  overrides: Partial<LoadGeneratorConfig> = {},
): LoadGeneratorConfig {
  return {
    testId: "test-1",
    sessionId: "session-a",
    deviceStart: 1,
    deviceCount: 2,
    connectionRatePerSecond: 1000,
    telemetryIntervalMs: 10,
    simulationSeed: "seed-a",
    maxMessages: 5,
    maxDurationMs: 1000,
    mqttUrl: "mqtt://localhost:1883",
    reportPath: "/tmp/load-result.json",
    ...overrides,
  };
}

function createHarness(options: { failPublish?: boolean } = {}) {
  const clients: Array<{
    client: LoadGeneratorMqttClient;
    endAsync: ReturnType<typeof vi.fn>;
    publishAsync: ReturnType<typeof vi.fn>;
  }> = [];
  let writtenReport: LoadGeneratorReport | undefined;
  const openConnection = vi.fn(() => {
    const publishAsync = options.failPublish
      ? vi.fn().mockRejectedValue(new Error("publish failed"))
      : vi.fn().mockResolvedValue(undefined);
    const endAsync = vi.fn().mockResolvedValue(undefined);
    const client = { publishAsync, endAsync };
    clients.push({ client, publishAsync, endAsync });
    return { client, connected: Promise.resolve() };
  });
  const writeReport = vi.fn(async (_path, report: LoadGeneratorReport) => {
    writtenReport = report;
  });
  return {
    clients,
    openConnection,
    writeReport,
    getWrittenReport: () => writtenReport,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createLoadDeviceIds", () => {
  it("creates non-overlapping ranges for multiple workers", () => {
    const first = createLoadDeviceIds(1, 3);
    const second = createLoadDeviceIds(4, 3);

    expect(first).toEqual(["load-000001", "load-000002", "load-000003"]);
    expect(second).toEqual(["load-000004", "load-000005", "load-000006"]);
    expect(first.filter((deviceId) => second.includes(deviceId))).toEqual([]);
  });
});

describe("runLoadGenerator", () => {
  it("stops at the message limit, records counters and closes every client", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const running = runLoadGenerator(createConfig(), {
      openConnection: harness.openConnection,
      writeReport: harness.writeReport,
    });

    await vi.advanceTimersByTimeAsync(100);
    const report = await running;

    expect(report.stopReason).toBe("MAX_MESSAGES");
    expect(report.counters).toEqual({ attempted: 5, succeeded: 5, failed: 0 });
    expect(
      report.devices.reduce((sum, device) => sum + device.attempted, 0),
    ).toBe(5);
    expect(report.devices.every((device) => device.lastSequence !== null)).toBe(
      true,
    );
    expect(harness.clients).toHaveLength(2);
    expect(
      harness.clients.every(({ endAsync }) => endAsync.mock.calls.length === 1),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.getWrittenReport()).toEqual(report);
  });

  it("stops at the duration limit and clears timers", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const running = runLoadGenerator(
      createConfig({
        deviceCount: 1,
        telemetryIntervalMs: 100,
        maxMessages: 100,
        maxDurationMs: 50,
      }),
      {
        openConnection: harness.openConnection,
        writeReport: harness.writeReport,
      },
    );

    await vi.advanceTimersByTimeAsync(50);
    const report = await running;

    expect(report.stopReason).toBe("MAX_DURATION");
    expect(report.counters).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(harness.clients[0]?.endAsync).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending connection when the duration limit is reached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const publishAsync = vi.fn().mockResolvedValue(undefined);
    const endAsync = vi.fn().mockResolvedValue(undefined);
    const openConnection = vi.fn(() => ({
      client: { publishAsync, endAsync },
      connected: new Promise<void>(() => undefined),
    }));
    const writeReport = vi.fn().mockResolvedValue(undefined);
    const running = runLoadGenerator(
      createConfig({ deviceCount: 1, maxMessages: 100, maxDurationMs: 50 }),
      { openConnection, writeReport },
    );

    await vi.advanceTimersByTimeAsync(50);
    const report = await running;

    expect(report.stopReason).toBe("MAX_DURATION");
    expect(report.counters.attempted).toBe(0);
    expect(publishAsync).not.toHaveBeenCalled();
    expect(endAsync).toHaveBeenCalledExactlyOnceWith(true);
    expect(openConnection).toHaveBeenCalledWith(
      "mqtt://localhost:1883",
      expect.objectContaining({ connectTimeout: 50 }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the configured connection rate between devices", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    const connectionTimes: number[] = [];
    const openConnection = vi.fn(
      (...arguments_: Parameters<typeof harness.openConnection>) => {
        connectionTimes.push(Date.now());
        return harness.openConnection(...arguments_);
      },
    );

    const running = runLoadGenerator(
      createConfig({
        deviceCount: 3,
        connectionRatePerSecond: 2,
        telemetryIntervalMs: 10_000,
        maxMessages: 3,
        maxDurationMs: 20_000,
      }),
      {
        openConnection,
        writeReport: harness.writeReport,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    const report = await running;

    expect(connectionTimes).toEqual([0, 500, 1_000]);
    expect(report.stopReason).toBe("MAX_MESSAGES");
    expect(openConnection).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts publish failures and still writes a report", async () => {
    const harness = createHarness({ failPublish: true });

    const report = await runLoadGenerator(
      createConfig({ deviceCount: 1, maxMessages: 1 }),
      {
        openConnection: harness.openConnection,
        writeReport: harness.writeReport,
      },
    );

    expect(report.counters).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    expect(report.devices[0]).toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      lastSequence: 0,
    });
    expect(harness.getWrittenReport()).toEqual(report);
  });
});
