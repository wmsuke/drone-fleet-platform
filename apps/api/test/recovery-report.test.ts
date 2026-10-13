import { describe, expect, it } from "vitest";
import { reconcile } from "./helpers/recovery-harness.js";
describe("recovery identity reconciliation", () => {
  it("distinguishes unrecorded loss from recorded capacity loss and duplicates", () => {
    expect(
      reconcile(
        ["session/0", "session/1", "session/2"],
        ["session/0", "session/0"],
        ["session/1"],
      ),
    ).toEqual({
      missing: ["session/2"],
      lost: ["session/1"],
      duplicates: ["session/0"],
    });
  });
  it("does not count discarded but already saved telemetry as loss", () => {
    expect(reconcile(["session/0"], ["session/0"], ["session/0"])).toEqual({
      missing: [],
      lost: [],
      duplicates: [],
    });
  });
});
