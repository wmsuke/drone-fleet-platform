import { afterEach, expect, it, vi } from "vitest";
import { createAlertWorker, type AlertRepository } from "../src/worker.js";
afterEach(() => vi.useRealTimers());
function fixture() {
  const repo: AlertRepository = {
    deviceIds: vi.fn(async () => ["a", "b"]),
    commandIds: vi.fn(async () => ["command"]),
    evaluateDevice: vi.fn(async () => ({
      created: 1,
      updated: 0,
      resolved: 0,
    })),
    evaluateCommand: vi.fn(async () => ({
      created: 0,
      updated: 1,
      resolved: 0,
    })),
  };
  const report = vi.fn();
  return { repo, report };
}
it("isolates per-target errors and reports committed results, failures and timing without exception payloads", async () => {
  const { repo, report } = fixture();
  vi.mocked(repo.evaluateDevice).mockRejectedValueOnce(
    new Error("secret error"),
  );
  const worker = createAlertWorker(repo, 5000, report);
  await worker.runOnce();
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      evaluated: 2,
      failed: 1,
      created: 1,
      updated: 1,
      resolved: 0,
      durationMs: expect.any(Number),
      evaluationLagMs: expect.any(Number),
    }),
  );
  expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
  await worker.stop();
});
it("coalesces concurrent evaluations and waits for in-flight work on shutdown", async () => {
  const { repo, report } = fixture();
  let release!: () => void;
  vi.mocked(repo.evaluateDevice).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { created: 0, updated: 0, resolved: 1 };
  });
  const worker = createAlertWorker(repo, 5000, report);
  const first = worker.runOnce();
  const second = worker.runOnce();
  expect(first).toBe(second);
  await vi.waitFor(() => expect(release).toBeDefined());
  const stopped = worker.stop();
  release();
  await stopped;
  expect(repo.evaluateDevice).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledOnce();
});
it("continues polling after failure and stops its timer", async () => {
  vi.useFakeTimers();
  const { repo, report } = fixture();
  vi.mocked(repo.deviceIds).mockRejectedValueOnce(new Error("unavailable"));
  const worker = createAlertWorker(repo, 5000, report);
  worker.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ failed: 1 }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(report).toHaveBeenCalledTimes(2);
  await worker.stop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(report).toHaveBeenCalledTimes(2);
});
