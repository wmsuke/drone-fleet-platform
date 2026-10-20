import { expect, it } from "vitest";
import { responseFor } from "../src/fleet-responder.js";
it("deterministically selects ten percent failure or silence and leaves the others succeeding", () => {
  for (const count of [10, 100, 1000])
    for (const condition of ["success", "failure", "unresponsive"] as const) {
      const results = Array.from({ length: count }, (_, i) =>
        responseFor(i + 1, condition),
      );
      expect(results.filter((r) => r === "SUCCEEDED")).toHaveLength(
        condition === "success" ? count : count * 0.9,
      );
      expect(results.filter((r) => r === "FAILED")).toHaveLength(
        condition === "failure" ? count * 0.1 : 0,
      );
      expect(results.filter((r) => r === null)).toHaveLength(
        condition === "unresponsive" ? count * 0.1 : 0,
      );
    }
});
