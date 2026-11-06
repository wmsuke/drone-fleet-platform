import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  bridgeEventMessageSchema,
  bridgeReceiptMessageSchema,
  bridgeConfigurationSchema,
  canonicalBridgeJson,
  supportsBridgeOperation,
  createBridgeEventsTopic,
  createBridgeReceiptsTopic,
  parseMqttTopic,
} from "../src/index.js";
import { fixtures, configuration } from "./fixtures/bridge.mjs";
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalBridgeJson(value)).digest("hex");
describe("Bridge capabilities and contracts", () => {
  it("shares exact generated schema and structural fixtures with Python", () => {
    const cases = fixtures(digest);
    expect(
      JSON.parse(
        readFileSync(
          new URL(
            "../../../ros/contracts/configuration-fixtures.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    ).toEqual(cases);
    for (const test of cases)
      expect(bridgeEventMessageSchema.safeParse(test.message).success).toBe(
        test.valid,
      );
    for (const [name, schema] of [
      ["bridge-event", bridgeEventMessageSchema],
      ["bridge-receipt", bridgeReceiptMessageSchema],
    ] as const)
      expect(
        JSON.parse(
          readFileSync(
            new URL(
              `../../../ros/contracts/${name}.schema.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ).toEqual(z.toJSONSchema(schema, { target: "draft-7", io: "input" }));
  });
  it("distinguishes declared ability from missing versions and REBOOT", () => {
    const value = bridgeConfigurationSchema.parse(configuration(digest));
    expect(supportsBridgeOperation(value, "RETURN_HOME")).toBe(true);
    expect(supportsBridgeOperation(value, "REBOOT")).toBe(false);
    expect(
      supportsBridgeOperation(
        {
          ...value,
          bridge: { status: "UNKNOWN", reason: "VERSION_UNREPORTED" },
        },
        "RETURN_HOME",
      ),
    ).toBe(false);
  });
  it("canonicalizes keys without floating-point or secret-bearing free extensions", () => {
    expect(canonicalBridgeJson({ z: 0, a: [true, null, "value"] })).toBe(
      '{"a":[true,null,"value"],"z":0}',
    );
    expect(() => canonicalBridgeJson({ value: 0.1 })).toThrow();
    for (const [create, kind] of [
      [createBridgeEventsTopic, "bridge-events"],
      [createBridgeReceiptsTopic, "bridge-receipts"],
    ] as const)
      expect(parseMqttTopic(create("drone-1"))).toEqual({
        deviceId: "drone-1",
        kind,
      });
  });
});
