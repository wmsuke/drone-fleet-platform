import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bridgeEventMessageSchema } from "../src/bridge.js";
import { healthFixtures } from "./fixtures/bridge-health.mjs";
it("health has no invented command or stop and keeps shared fixtures", () => {
  for (const fixture of healthFixtures)
    expect(bridgeEventMessageSchema.safeParse(fixture.message).success).toBe(
      fixture.valid,
    );
  expect(
    JSON.parse(
      readFileSync(
        new URL("../../../ros/contracts/health-fixtures.json", import.meta.url),
        "utf8",
      ),
    ),
  ).toEqual(healthFixtures);
});
