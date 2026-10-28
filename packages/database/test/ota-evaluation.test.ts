import { describe, expect, it } from "vitest";
import { evaluateOta } from "../src/ota-evaluation.js";
import { otaFixture } from "./ota-fixture.js";
describe("ota-health-v1 evidence evaluation", () => {
  it("requires actual application, boot and 60 seconds of 13 samples", () => {
    const f = otaFixture();
    expect(evaluateOta(f.apply, f.rows, f.at(71000)).status).toBe("SUCCEEDED");
    expect(
      evaluateOta(f.apply, f.rows.slice(0, 2), f.at(1000)).status,
    ).not.toBe("SUCCEEDED");
    expect(evaluateOta(f.apply, [f.rows.at(-1)!], f.at(71000)).status).not.toBe(
      "SUCCEEDED",
    );
  });
  it.each(["HEALTH", "VERSION", "VERIFIED", "SWITCHING", "APPLIED"])(
    "does not invent missing %s evidence",
    (type) => {
      const f = otaFixture();
      const rows = f.rows.filter(
        (r) => r.payload.type !== type && r.payload.state !== type,
      );
      expect(evaluateOta(f.apply, rows, f.at(71000)).status).not.toBe(
        "SUCCEEDED",
      );
      expect(evaluateOta(f.apply, rows, f.at(600000)).status).toBe("UNCERTAIN");
    },
  );
  it("does not repair failed health, stale samples, or sequence gaps", () => {
    const f = otaFixture();
    const failed = structuredClone(f.rows);
    (failed[10]!.payload.checks as Record<string, string>).sqlite = "FAILED";
    expect(evaluateOta(f.apply, failed, f.at(71000)).status).toBe("FAILED");
    expect(evaluateOta(f.apply, f.rows, f.at(85000)).status).not.toBe(
      "SUCCEEDED",
    );
    expect(
      evaluateOta(
        f.apply,
        f.rows.filter((r) => r.sequence !== 10n),
        f.at(71000),
      ).reason,
    ).toBe("SEQUENCE_GAP");
  });
  it("rejects server/monotonic gaps, reversed time and insufficient server observation", () => {
    for (const kind of [
      "server-gap",
      "monotonic-gap",
      "reversed",
      "compressed",
    ]) {
      const f = otaFixture(),
        rows = structuredClone(f.rows);
      if (kind === "server-gap") rows[15]!.storedAt = f.at(100000);
      if (kind === "monotonic-gap")
        rows[15]!.payload.sampleMonotonicMs = 999999;
      if (kind === "reversed") rows[15]!.payload.sampleMonotonicMs = 1;
      if (kind === "compressed")
        for (const row of rows.filter((r) => r.payload.type === "HEALTH"))
          row.storedAt = f.at(70000);
      expect(evaluateOta(f.apply, rows, f.at(71000)).status).not.toBe(
        "SUCCEEDED",
      );
    }
  });
  it("uses strict resultDeadline for both receipt and storage", () => {
    const f = otaFixture();
    for (const key of ["receivedAt", "storedAt"] as const) {
      const rows = structuredClone(f.rows);
      rows.at(-1)![key] = f.at(600000);
      expect(evaluateOta(f.apply, rows, f.at(600000)).status).toBe("UNCERTAIN");
    }
  });
  it("preserves earlier success but records subsequent bad evidence separately", () => {
    const f = otaFixture(),
      first = evaluateOta(f.apply, f.rows, f.at(71000));
    expect(evaluateOta(f.apply, f.rows, f.at(700000), first)).toEqual(first);
    const failed = structuredClone(f.rows);
    (failed[10]!.payload.checks as Record<string, string>).sqlite = "FAILED";
    expect(evaluateOta(f.apply, failed, f.at(71000), first).status).toBe(
      "FAILED",
    );
  });
});
