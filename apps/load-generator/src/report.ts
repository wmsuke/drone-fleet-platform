import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LoadGeneratorConfig } from "./config.js";

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
  config: Omit<LoadGeneratorConfig, "testId" | "sessionId" | "reportPath">;
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
