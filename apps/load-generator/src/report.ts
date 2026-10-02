import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type StopReason = "MAX_MESSAGES" | "MAX_DURATION" | "SIGNAL" | "ERROR";

export interface DeviceSendResult {
  deviceId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  lastSequence: number | null;
}

export interface LoadGeneratorReport {
  schemaVersion: 1;
  testId: string;
  sessionId: string;
  config: {
    deviceStart: number;
    deviceCount: number;
    connectionRatePerSecond: number;
    telemetryIntervalMs: number;
    simulationSeed: string;
    maxMessages: number;
    maxDurationMs: number;
    measurementStartAt?: string;
    measurementDurationMs?: number;
    mqttUrl: string;
    transport: "local" | "aws-iot";
    topicPrefix: string;
    readyPath?: string;
    awsIot?: {
      ruleName: string;
      monthToDateMessages: number;
      projectMonthlyMessageLimit: number;
    };
  };
  startedAt: string;
  endedAt: string;
  stopReason: StopReason;
  counters: {
    attempted: number;
    succeeded: number;
    failed: number;
  };
  devices: DeviceSendResult[];
}

export async function writeLoadGeneratorReport(
  path: string,
  report: LoadGeneratorReport,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
}

export async function writeLoadGeneratorReady(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "ready\n", "utf8");
}
