import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  bridgeEventMessageSchema,
  bridgeConfigurationSchema,
} from "../src/index.js";
import { actionFixtures } from "./fixtures/bridge-actions.mjs";
import { configuration } from "./fixtures/bridge.mjs";
import { createHash } from "node:crypto";
import { canonicalBridgeJson } from "../src/index.js";
describe("Bridge Action evidence", () => {
  it("shares structural contracts with Python without inventing starts or completions", () => {
    expect(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../ros/contracts/action-fixtures.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    ).toEqual(actionFixtures);
    for (const fixture of actionFixtures)
      expect(bridgeEventMessageSchema.safeParse(fixture.message).success).toBe(
        fixture.valid,
      );
  });
  it("continues to read the old configuration while identifying the new profile", () => {
    const digest = (v: unknown) =>
      createHash("sha256").update(canonicalBridgeJson(v)).digest("hex");
    const current = configuration(digest);
    expect(
      bridgeConfigurationSchema.parse(current).profile.definition.version,
    ).toBe("1.1.0");
    const legacy = structuredClone(current);
    legacy.bridge.version = "0.2.0";
    legacy.adapter.version = "0.2.0";
    legacy.profile.definition.version = "1.0.0";
    delete legacy.profile.definition.resultCacheMs;
    expect(bridgeConfigurationSchema.safeParse(legacy).success).toBe(true);
  });
});
