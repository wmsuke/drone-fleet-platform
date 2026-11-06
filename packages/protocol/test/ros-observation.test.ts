import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { fixtures, observation } from "./fixtures/ros-observations.mjs";
import {
  rosObservationMessageSchema,
  telemetryMessageSchema,
} from "../src/index.js";

describe("ROS observation contract", () => {
  it("shares fixtures and generated structural validation with Python", () => {
    for (const test of fixtures)
      expect(telemetryMessageSchema.safeParse(test.message).success).toBe(
        test.valid,
      );
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../ros/contracts/ros-observation.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(schema).toEqual(
      z.toJSONSchema(rosObservationMessageSchema, {
        target: "draft-7",
        io: "input",
      }),
    );
    expect(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../ros/contracts/observation-fixtures.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    ).toEqual(fixtures);
  });
  it("does not accept fabricated values with missing quality", () => {
    const message = structuredClone(observation);
    message.payload.temperature = 0;
    expect(telemetryMessageSchema.safeParse(message).success).toBe(false);
  });
});
