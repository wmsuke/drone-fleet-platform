import { createTelemetryTopic } from "@drone-fleet/protocol";
import { connectAsync, type IClientOptions } from "mqtt";

import type { LoadGeneratorConfig } from "./config.js";
import {
  writeLoadGeneratorReport,
  type DeviceSendResult,
  type LoadGeneratorReport,
  type StopReason,
} from "./report.js";
import { createLoadTelemetry } from "./telemetry.js";

export interface LoadGeneratorMqttClient {
  publishAsync(
    topic: string,
    message: string,
    options: { qos: 0; retain: false },
  ): Promise<unknown>;
  endAsync(force?: boolean): Promise<void>;
}

export type ConnectLoadGeneratorClient = (
  url: string,
  options: IClientOptions,
) => Promise<LoadGeneratorMqttClient>;

export interface LoadGeneratorDependencies {
  connectClient?: ConnectLoadGeneratorClient;
  now?: () => Date;
  writeReport?: (path: string, report: LoadGeneratorReport) => Promise<void>;
  signal?: AbortSignal;
}

interface DeviceRuntime extends DeviceSendResult {
  nextSequence: number;
  client?: LoadGeneratorMqttClient;
  timer?: NodeJS.Timeout;
}

export function createLoadDeviceIds(
  deviceStart: number,
  deviceCount: number,
): string[] {
  if (!Number.isSafeInteger(deviceStart) || deviceStart < 1) {
    throw new TypeError("deviceStart must be a positive safe integer");
  }
  if (!Number.isSafeInteger(deviceCount) || deviceCount < 1) {
    throw new TypeError("deviceCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(deviceStart + deviceCount - 1)) {
    throw new RangeError("device range exceeds the safe integer range");
  }

  return Array.from(
    { length: deviceCount },
    (_, offset) => `load-${String(deviceStart + offset).padStart(6, "0")}`,
  );
}

async function waitForConnectionSlot(
  milliseconds: number,
  stopped: Promise<void>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  await Promise.race([elapsed, stopped]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

export async function runLoadGenerator(
  config: LoadGeneratorConfig,
  dependencies: LoadGeneratorDependencies = {},
): Promise<LoadGeneratorReport> {
  const connectClient = dependencies.connectClient ?? connectAsync;
  const now = dependencies.now ?? (() => new Date());
  const writeReport = dependencies.writeReport ?? writeLoadGeneratorReport;
  const startedAt = now().toISOString();
  const devices: DeviceRuntime[] = createLoadDeviceIds(
    config.deviceStart,
    config.deviceCount,
  ).map((deviceId) => ({
    deviceId,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    lastSequence: null,
    nextSequence: 0,
  }));
  const counters = { attempted: 0, succeeded: 0, failed: 0 };
  const inFlight = new Set<Promise<void>>();
  let stopReason: StopReason | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const requestStop = (reason: StopReason): void => {
    if (stopReason !== undefined) {
      return;
    }
    stopReason = reason;
    resolveStopped?.();
  };
  const durationTimer = setTimeout(
    () => requestStop("MAX_DURATION"),
    config.maxDurationMs,
  );
  const abort = (): void => requestStop("SIGNAL");
  dependencies.signal?.addEventListener("abort", abort, { once: true });

  let executionError: unknown;
  const publish = (device: DeviceRuntime): void => {
    if (
      stopReason !== undefined ||
      device.client === undefined ||
      counters.attempted >= config.maxMessages
    ) {
      if (counters.attempted >= config.maxMessages) {
        requestStop("MAX_MESSAGES");
      }
      return;
    }

    const sequence = device.nextSequence;
    device.nextSequence += 1;
    device.lastSequence = sequence;
    device.attempted += 1;
    counters.attempted += 1;
    const telemetry = createLoadTelemetry(
      device.deviceId,
      sequence,
      now().toISOString(),
      config.simulationSeed,
    );
    const publishing = device.client
      .publishAsync(
        createTelemetryTopic(device.deviceId),
        JSON.stringify(telemetry),
        { qos: 0, retain: false },
      )
      .then(() => {
        device.succeeded += 1;
        counters.succeeded += 1;
      })
      .catch(() => {
        device.failed += 1;
        counters.failed += 1;
      })
      .finally(() => {
        inFlight.delete(publishing);
        if (counters.attempted >= config.maxMessages) {
          requestStop("MAX_MESSAGES");
        }
      });
    inFlight.add(publishing);
  };

  try {
    if (dependencies.signal?.aborted === true) {
      requestStop("SIGNAL");
    }
    const connectionDelayMs = 1_000 / config.connectionRatePerSecond;
    for (const [index, device] of devices.entries()) {
      if (stopReason !== undefined) {
        break;
      }
      device.client = await connectClient(config.mqttUrl, {
        clean: true,
        clientId: `load-${config.sessionId}-${device.deviceId}`,
        reconnectPeriod: 0,
      });
      publish(device);
      if (stopReason === undefined) {
        device.timer = setInterval(
          () => publish(device),
          config.telemetryIntervalMs,
        );
      }
      if (index < devices.length - 1 && stopReason === undefined) {
        await waitForConnectionSlot(connectionDelayMs, stopped);
      }
    }
    if (stopReason === undefined) {
      await stopped;
    }
  } catch (error) {
    executionError = error;
    requestStop("ERROR");
  } finally {
    clearTimeout(durationTimer);
    dependencies.signal?.removeEventListener("abort", abort);
    for (const device of devices) {
      if (device.timer !== undefined) {
        clearInterval(device.timer);
      }
    }
    await Promise.allSettled([...inFlight]);
    const closeResults = await Promise.allSettled(
      devices.flatMap((device) =>
        device.client === undefined ? [] : [device.client.endAsync(false)],
      ),
    );
    const closeFailure = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (closeFailure !== undefined && executionError === undefined) {
      executionError = closeFailure.reason;
      stopReason = "ERROR";
    }
  }

  const report: LoadGeneratorReport = {
    schemaVersion: 1,
    testId: config.testId,
    sessionId: config.sessionId,
    config: {
      deviceStart: config.deviceStart,
      deviceCount: config.deviceCount,
      connectionRatePerSecond: config.connectionRatePerSecond,
      telemetryIntervalMs: config.telemetryIntervalMs,
      simulationSeed: config.simulationSeed,
      maxMessages: config.maxMessages,
      maxDurationMs: config.maxDurationMs,
      mqttUrl: config.mqttUrl,
    },
    startedAt,
    endedAt: now().toISOString(),
    stopReason: stopReason ?? "ERROR",
    counters,
    devices: devices.map((device) => ({
      deviceId: device.deviceId,
      attempted: device.attempted,
      succeeded: device.succeeded,
      failed: device.failed,
      lastSequence: device.lastSequence,
    })),
  };
  await writeReport(config.reportPath, report);

  if (executionError !== undefined) {
    throw executionError;
  }
  return report;
}
