import { expect, it } from "vitest";
import {
  commandAcknowledgementMessageSchema,
  commandAcknowledgementV3MessageSchema,
} from "../src/index.js";
const receipt = {
  schemaVersion: 3,
  commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
  deviceId: "drone-001",
  timestamp: "2026-10-14T00:00:02.000Z",
  status: "ACKNOWLEDGED",
};
it.each(["ACKNOWLEDGED", "REJECTED_EXPIRED"])(
  "validates v3 receipt %s independently of execution",
  (status) => {
    expect(
      commandAcknowledgementMessageSchema.safeParse({ ...receipt, status })
        .success,
    ).toBe(true);
    expect(
      commandAcknowledgementV3MessageSchema.safeParse({
        ...receipt,
        status,
        startedAt: receipt.timestamp,
      }).success,
    ).toBe(false);
  },
);
it.each(["RUNNING", "SUCCEEDED", "FAILED", "UNCERTAIN"])(
  "requires valid start/time for %s",
  (status) => {
    expect(
      commandAcknowledgementMessageSchema.safeParse({
        ...receipt,
        status,
        startedAt: "2026-10-14T00:00:01.000Z",
      }).success,
    ).toBe(true);
    expect(
      commandAcknowledgementMessageSchema.safeParse({ ...receipt, status })
        .success,
    ).toBe(false);
    expect(
      commandAcknowledgementMessageSchema.safeParse({
        ...receipt,
        status,
        startedAt: "2026-10-14T00:00:03.000Z",
      }).success,
    ).toBe(false);
  },
);
