import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  GeneratorReport,
  IngestorReport,
  LoadTestReport,
} from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function readReport(path: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`レポートを読み込めません: ${path}`, { cause: error });
  }
  const report = object(value, path);
  if (
    report.schemaVersion !== 1 ||
    typeof report.testId !== "string" ||
    typeof report.sessionId !== "string" ||
    typeof report.startedAt !== "string" ||
    typeof report.endedAt !== "string"
  ) {
    throw new TypeError(`レポート形式が不正です: ${path}`);
  }
  return report;
}

export async function readGeneratorReport(
  path: string,
): Promise<GeneratorReport> {
  const report = await readReport(path);
  if (
    !Array.isArray(report.devices) ||
    typeof report.config !== "object" ||
    report.config === null ||
    typeof report.counters !== "object" ||
    report.counters === null
  ) {
    throw new TypeError(`generatorレポート形式が不正です: ${path}`);
  }
  return report as unknown as GeneratorReport;
}

export async function readIngestorReport(
  path: string,
): Promise<IngestorReport> {
  const report = await readReport(path);
  if (
    typeof report.counters !== "object" ||
    report.counters === null ||
    typeof report.timings !== "object" ||
    report.timings === null
  ) {
    throw new TypeError(`ingestorレポート形式が不正です: ${path}`);
  }
  return report as unknown as IngestorReport;
}

export async function writeJsonReport(
  path: string,
  report: unknown,
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

export function writeLoadTestReport(
  path: string,
  report: LoadTestReport,
): Promise<void> {
  return writeJsonReport(path, report);
}
