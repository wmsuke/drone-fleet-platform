import { describe, it, expect } from "vitest";
import { recoveryBlock, actionBlock } from "../src/ota-safety.js";
import { deploymentSchema } from "../src/ota-api.js";
import { otaFixture } from "./ota-fixtures.js";

describe("OTA conservative recovery controls", () => {
  it.each(["RETRY", "ROLLBACK"] as const)(
    "offers a verified %s candidate and leaves final release validation to the API",
    (kind) => {
      const f = otaFixture();
      f.failed(kind);
      expect(recoveryBlock(f.data, f.data.targets[0]!, kind, f.now)).toBeNull();
    },
  );
  it.each(["UNCERTAIN", "RUNNING", "PENDING"])(
    "never reruns a previous %s evaluation",
    (state) => {
      const f = otaFixture();
      f.failed();
      f.data.targets[0]!.attempts[0]!.evaluationStatus = state;
      expect(
        recoveryBlock(f.data, f.data.targets[0]!, "RETRY", f.now),
      ).not.toBeNull();
    },
  );
  it.each(["STOPPING", "WAITING_FOR_HUMAN", "RUNNING"] as const)(
    "never starts recovery while deployment is %s",
    (state) => {
      const f = otaFixture();
      f.failed();
      f.data.status = state;
      expect(
        recoveryBlock(f.data, f.data.targets[0]!, "RETRY", f.now),
      ).not.toBeNull();
    },
  );
  it.each([
    "signature",
    "applied",
    "stale",
    "boot",
    "readiness",
    "budget",
    "unknown-time",
    "bytes",
    "truncated",
    "state",
  ])("blocks %s instead of assuming recovery is safe", (fault) => {
    const f = otaFixture();
    f.failed();
    const t = f.data.targets[0]!,
      a = t.attempts[0]!,
      i = t.observation!.payload;
    if (fault === "signature")
      a.events[1]!.payload.reason = "SIGNATURE_INVALID";
    if (fault === "applied") a.events[1]!.payload.state = "VERIFIED";
    if (fault === "stale") t.observation!.receivedAt = f.at(-15000);
    if (fault === "boot") i.running.bootId = crypto.randomUUID();
    if (fault === "readiness") i.readiness!.receipts = "FAILED";
    if (fault === "budget") {
      i.recovery!.detectedAt = f.at(-300000);
      i.recovery!.budgetDeadline = f.at(600000);
    }
    if (fault === "unknown-time") i.recovery!.detectedAt = null;
    if (fault === "bytes") i.recovery!.downloadedBytes = 255;
    if (fault === "truncated") a.eventsTruncated = true;
    if (fault === "state") a.events = a.events.slice(1);
    expect(recoveryBlock(f.data, t, "RETRY", f.now)).not.toBeNull();
  });
  it("cannot resume a failed, uncertain, stopped or rollback attempt", () => {
    const f = otaFixture();
    f.failed();
    expect(
      actionBlock(
        {
          action: "RESUME",
          deploymentId: f.data.deploymentId,
          body: { reason: "CHECKED" },
        },
        f.data,
        f.now,
      ),
    ).not.toBeNull();
  });
  it("refuses an incomplete target snapshot rather than shrinking the fixed denominator", () => {
    const f = otaFixture();
    f.data.targets.pop();
    expect(() => deploymentSchema.parse(f.data)).toThrow();
  });
  it("does not promote a later stage using a recovered target or a missing health observation", () => {
    const f = otaFixture();
    f.data.status = "RUNNING";
    f.data.stages[0]!.status = "PASSED";
    f.data.stages[0]!.counts = { RECOVERED: 1 };
    f.data.stages[1]!.status = "AWAITING_APPROVAL";
    expect(
      actionBlock(
        {
          action: "APPROVE",
          deploymentId: f.data.deploymentId,
          stageId: f.data.stages[1]!.stageId,
          body: { reason: "CHECKED" },
        },
        f.data,
        f.now,
      ),
    ).not.toBeNull();
  });
});
