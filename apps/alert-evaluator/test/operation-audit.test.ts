import { afterEach, expect, it, vi } from "vitest";
import { createOperationAuditWorker } from "../src/operation-audit.js";
afterEach(() => vi.useRealTimers());
it("deduplicates concurrent cycles, counts changes/failures and stops polling", async () => {
  vi.useFakeTimers();
  const repo = {
    operationIds: vi.fn(async () => ["one", "two"]),
    evaluateOperation: vi.fn(async (id: string) => {
      if (id === "two") throw Error("database unavailable");
      return true;
    }),
  };
  const report = vi.fn();
  const worker = createOperationAuditWorker(repo, 5000, report);
  await Promise.all([worker.runOnce(), worker.runOnce()]);
  expect(repo.operationIds).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith({ evaluated: 1, changed: 1, failed: 1 });
  worker.start();
  await vi.advanceTimersByTimeAsync(1);
  await worker.stop();
  const count = repo.operationIds.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(repo.operationIds).toHaveBeenCalledTimes(count);
});
it("counts scan failures and tolerates reporting failure", async () => {
  const worker = createOperationAuditWorker(
    {
      operationIds: async () => {
        throw Error("database unavailable");
      },
      evaluateOperation: async () => false,
    },
    5000,
    () => {
      throw Error("logger unavailable");
    },
  );
  await expect(worker.runOnce()).resolves.toBeUndefined();
  await worker.stop();
});
