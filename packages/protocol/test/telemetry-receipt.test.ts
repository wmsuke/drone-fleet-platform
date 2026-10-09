import { describe, expect, it } from "vitest";
import { telemetryReceiptMessageSchema } from "../src/index.js";

const receipt = {
  schemaVersion: 1,
  deviceId: "drone-001",
  sessionId: "a065e32b-c00b-452e-9cb1-3b52c43962fb",
  sequence: 0,
  timestamp: "2026-10-09T00:00:00.000Z",
  status: "STORED",
};
describe("telemetry receipt", () => {
  it("accepts a saved identity", () =>
    expect(telemetryReceiptMessageSchema.parse(receipt)).toEqual(receipt));
  it.each([
    { schemaVersion: 2 },
    { status: "FAILED" },
    { sequence: -1 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: "invalid" },
    { deviceId: "other/device" },
    { timestamp: "invalid" },
    { payload: {} },
  ])("rejects invalid receipts: %j", (change) => {
    expect(
      telemetryReceiptMessageSchema.safeParse({ ...receipt, ...change })
        .success,
    ).toBe(false);
  });
});
