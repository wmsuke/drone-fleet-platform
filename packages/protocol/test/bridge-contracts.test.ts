import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { connectionStatusMessageSchema } from "../src/connection-status.js";

describe("ROS Bridge shared status contract", () => {
  it("keeps exported schema and shared fixtures in sync", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../ros/contracts/connection-status.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(schema).toEqual(
      z.toJSONSchema(connectionStatusMessageSchema, {
        target: "draft-7",
        io: "input",
      }),
    );
    const fixtures = readFileSync(
      new URL("fixtures/bridge-status.json", import.meta.url),
      "utf8",
    );
    expect(
      readFileSync(
        new URL("../../../ros/contracts/status-fixtures.json", import.meta.url),
        "utf8",
      ),
    ).toBe(fixtures);
    for (const { message, valid } of JSON.parse(fixtures)) {
      expect(connectionStatusMessageSchema.safeParse(message).success).toBe(
        valid,
      );
    }
  });
});
