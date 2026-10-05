import { createTelemetryTopic } from "@drone-fleet/protocol";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, type IClientOptions } from "mqtt";

import type { LoadGeneratorConfig } from "./config.js";
import {
  writeLoadGeneratorReport,
  writeLoadGeneratorReady,
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

export interface OpeningLoadGeneratorConnection {
  client: LoadGeneratorMqttClient;
  connected: Promise<void>;
}

export type OpenLoadGeneratorConnection = (
  url: string,
  options: IClientOptions,
) => OpeningLoadGeneratorConnection;

export interface LoadGeneratorDependencies {
  openConnection?: OpenLoadGeneratorConnection;
  now?: () => Date;
  writeReport?: (path: string, report: LoadGeneratorReport) => Promise<void>;
  writeReady?: (path: string) => Promise<void>;
  signal?: AbortSignal;
  readCredential?: (path: string) => Promise<Buffer>;
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

function openMqttConnection(
  url: string,
  options: IClientOptions,
): OpeningLoadGeneratorConnection {
  const client = connect(url, options);
  client.on("error", () => undefined);
  const connected = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      client.off("connect", onConnect);
      client.off("error", onError);
      client.off("close", onClose);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("MQTT connection closed before it was established"));
    };
    client.once("connect", onConnect);
    client.once("error", onError);
    client.once("close", onClose);
  });
  return { client, connected };
}

export async function runLoadGenerator(
  config: LoadGeneratorConfig,
  dependencies: LoadGeneratorDependencies = {},
): Promise<LoadGeneratorReport> {
  const openConnection = dependencies.openConnection ?? openMqttConnection;
  const now = dependencies.now ?? (() => new Date());
  const writeReport = dependencies.writeReport ?? writeLoadGeneratorReport;
  const writeReady = dependencies.writeReady ?? writeLoadGeneratorReady;
  const readCredential = dependencies.readCredential ?? readFile;
  const rootCa =
    config.awsIot === undefined
      ? undefined
      : await readCredential(config.awsIot.rootCaPath);
  const processStartedAtMs = now().getTime();
  const measurementStartAtMs =
    config.measurementStartAt?.getTime() ?? processStartedAtMs;
  const deadlineMs =
    config.measurementStartAt === undefined
      ? processStartedAtMs + config.maxDurationMs
      : measurementStartAtMs + (config.measurementDurationMs ?? 0);
  const startedAt = new Date(measurementStartAtMs).toISOString();
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
    Math.max(0, deadlineMs - now().getTime()),
  );
  const abort = (): void => requestStop("SIGNAL");
  dependencies.signal?.addEventListener("abort", abort, { once: true });

  let executionError: unknown;
  const publish = (device: DeviceRuntime): void => {
    const sentAt = now();
    const measured =
      sentAt.getTime() >= measurementStartAtMs && sentAt.getTime() < deadlineMs;
    if (
      stopReason !== undefined ||
      device.client === undefined ||
      (measured && counters.attempted >= config.maxMessages)
    ) {
      if (counters.attempted >= config.maxMessages) {
        requestStop("MAX_MESSAGES");
      }
      return;
    }

    const sequence = device.nextSequence;
    device.nextSequence += 1;
    if (measured) {
      device.lastSequence = sequence;
      device.attempted += 1;
      counters.attempted += 1;
    }
    const telemetry = createLoadTelemetry(
      device.deviceId,
      sequence,
      sentAt.toISOString(),
      config.simulationSeed,
    );
    const publishing = device.client
      .publishAsync(
        `${config.topicPrefix}${createTelemetryTopic(device.deviceId)}`,
        JSON.stringify(telemetry),
        { qos: 0, retain: false },
      )
      .then(() => {
        if (measured) {
          device.succeeded += 1;
          counters.succeeded += 1;
        }
      })
      .catch(() => {
        if (measured) {
          device.failed += 1;
          counters.failed += 1;
        }
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
      const remainingDurationMs = deadlineMs - now().getTime();
      if (remainingDurationMs <= 0) {
        requestStop("MAX_DURATION");
        break;
      }
      const opening = openConnection(config.mqttUrl, {
        clean: true,
        clientId:
          config.transport === "aws-iot"
            ? device.deviceId
            : `load-${config.sessionId}-${device.deviceId}`,
        connectTimeout: Math.max(1, Math.floor(remainingDurationMs)),
        reconnectPeriod: 0,
        ...(config.awsIot === undefined
          ? {}
          : {
              protocol: "mqtts" as const,
              rejectUnauthorized: true,
              ca: rootCa,
              cert: await readCredential(
                join(
                  config.awsIot.deviceCredentialsDirectory,
                  device.deviceId,
                  "device.pem.crt",
                ),
              ),
              key: await readCredential(
                join(
                  config.awsIot.deviceCredentialsDirectory,
                  device.deviceId,
                  "private.pem.key",
                ),
              ),
            }),
      });
      const connectionResult = opening.connected.then(
        () => ({ status: "connected" as const }),
        (error: unknown) => ({ status: "failed" as const, error }),
      );
      const result = await Promise.race([
        connectionResult,
        stopped.then(() => ({ status: "stopped" as const })),
      ]);
      if (result.status === "stopped") {
        await opening.client.endAsync(true);
        break;
      }
      if (result.status === "failed") {
        await opening.client.endAsync(true);
        throw result.error;
      }
      if (stopReason !== undefined) {
        await opening.client.endAsync(true);
        break;
      }
      device.client = opening.client;
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
    if (stopReason === undefined && config.readyPath !== undefined) {
      await writeReady(config.readyPath);
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
      ...(config.measurementStartAt === undefined
        ? {}
        : {
            measurementStartAt: config.measurementStartAt.toISOString(),
            measurementDurationMs: config.measurementDurationMs,
          }),
      mqttUrl: config.mqttUrl,
      transport: config.transport,
      topicPrefix: config.topicPrefix,
      ...(config.awsIot === undefined
        ? {}
        : {
            awsIot: {
              ruleName: config.awsIot.ruleName,
              monthToDateMessages: config.awsIot.monthToDateMessages,
              projectMonthlyMessageLimit: 200_000,
            },
          }),
      ...(config.readyPath === undefined
        ? {}
        : { readyPath: config.readyPath }),
    },
    startedAt,
    endedAt:
      stopReason === "MAX_DURATION"
        ? new Date(deadlineMs).toISOString()
        : now().toISOString(),
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
