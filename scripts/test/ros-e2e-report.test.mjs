import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize, requiredCases, evidenceLog } from "../ros-e2e-report.mjs";

const input = () => ({
  metadata: {
    awsExecuted: false,
    rosEnvironment: { packagesSha256: "test-lock" },
  },
  evidence: requiredCases.map((name) => ({ case: name })),
  measurements: [{ durationMs: 4 }, { durationMs: 20 }],
  cleanup: {
    exitCode: 0,
    containers: [],
    volumes: [],
    networks: [],
    images: [],
  },
  reconciliation: { verified: true },
  exitCode: 0,
});
describe("ROS専用E2Eの完了・未実行・cleanup", () => {
  it("requires the exact cases and measured values, not an assumed successful run", () => {
    const report = summarize(input());
    expect(report.status).toBe("PASSED");
    expect(new Set(requiredCases).size).toBe(requiredCases.length);
    expect(report.http.latencyMs).toMatchObject({ p50: 4, p95: 20, max: 20 });
    expect(report.unverified).toContain("AWS経路・費用");
  });
  it("marks missing cases NOT_EXECUTED and keeps a failed process failed", () => {
    const value = input();
    value.evidence = [];
    value.exitCode = 1;
    const report = summarize(value);
    expect(report.status).toBe("FAILED");
    expect(report.checks.every((c) => c.status === "NOT_EXECUTED")).toBe(true);
  });
  it("rejects duplicate/unexpected cases, missing reconciliation and cleanup leftovers", () => {
    const value = input();
    value.evidence.push(value.evidence[0], { case: "unexpected" });
    value.cleanup.exitCode = 1;
    const report = summarize({ ...value, reconciliation: null });
    expect(report.status).toBe("FAILED");
    expect(report.errors).toContain("cleanup incomplete");
    expect(report.errors).toContain("DB reconciliation not verified");
  });
  it("distinguishes the attempted failed case from cases that were never run", () => {
    const report = summarize({
      ...input(),
      evidence: [],
      exitCode: 1,
      activeCase: requiredCases[0],
    });
    expect(report.checks[0].status).toBe("FAILED");
    expect(report.checks[1].status).toBe("NOT_EXECUTED");
    expect(report.errors).not.toContain("cleanup incomplete");
  });
  it("rejects leftover resources even if the cleanup command exited successfully", () => {
    for (const kind of ["containers", "volumes", "networks", "images"]) {
      const value = input();
      value.cleanup[kind] = ["leftover"];
      expect(summarize(value).errors).toContain("cleanup incomplete");
    }
  });
  it("does not pass when the latency evidence is absent or invalid", () => {
    for (const measurements of [
      [],
      [{ durationMs: -1 }],
      [{ durationMs: null }],
    ]) {
      const report = summarize({ ...input(), measurements });
      expect(report.status).toBe("FAILED");
      expect(report.errors).toContain(
        "HTTP latency measurements missing or invalid",
      );
    }
  });
  it("persists completed cases before the next case can fail", () => {
    const directory = mkdtempSync(join(tmpdir(), "ros-evidence-test-"));
    try {
      const file = join(directory, "evidence.json");
      const log = evidenceLog(file);
      log.begin(requiredCases[0]);
      expect(
        JSON.parse(readFileSync(join(directory, "current-case.json"), "utf8")),
      ).toBe(requiredCases[0]);
      log.push({ case: requiredCases[0] });
      expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(log))[0].observedAt).toBeTruthy();
      expect(
        JSON.parse(readFileSync(join(directory, "current-case.json"), "utf8")),
      ).toBeNull();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
