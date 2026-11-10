import { describe, it, expect } from "vitest";
import {
  bridgeCancelRequestSchema,
  bridgeCancelEventSchema,
  validCancelDeadline,
  createBridgeRequestsTopic,
  parseMqttTopic,
} from "../src/index.js";
import { cancelFixtures } from "./fixtures/bridge-cancels.mjs";
describe("fixed goal cancel contract", () => {
  it("requires the actual target in acceptance and preserves code zero with an empty list as not accepted", () => {
    const request = bridgeCancelRequestSchema.parse(cancelFixtures[0]!.message);
    const event = {
      schemaVersion: 1,
      kind: "CANCEL",
      deviceId: request.deviceId,
      timestamp: request.timestamp,
      commandId: request.commandId,
      goalId: request.goalId,
      configurationId: request.configurationId,
      serverInstanceId: request.serverInstanceId,
      requestId: request.requestId,
      cancelId: request.cancelId,
      eventId: request.requestId,
      journalId: request.commandId,
      sessionId: request.goalId,
      sequence: 1,
      phase: "ACCEPTED",
      reason: "CANCEL_ACCEPTED",
      attempt: 1,
      response: {
        returnCode: 0,
        goalsCanceling: [request.goalId],
        cdr: "dW5pdA==",
        hash: "a".repeat(64),
      },
    };
    expect(bridgeCancelEventSchema.safeParse(event).success).toBe(true);
    const empty = {
      ...event,
      response: { ...event.response, goalsCanceling: [] },
    };
    expect(bridgeCancelEventSchema.safeParse(empty).success).toBe(false);
    expect(
      bridgeCancelEventSchema.safeParse({
        ...empty,
        phase: "REJECTED",
        reason: "NO_GOAL_CANCELING",
      }).success,
    ).toBe(true);
    expect(
      bridgeCancelEventSchema.safeParse({
        ...event,
        phase: "ACCEPTED",
        response: undefined,
      }).success,
    ).toBe(false);
  });
  it("shares strict identity and ten-second deadline fixtures with Python", () => {
    for (const fixture of cancelFixtures) {
      const parsed = bridgeCancelRequestSchema.safeParse(fixture.message);
      expect(parsed.success && validCancelDeadline(parsed.data)).toBe(
        fixture.valid,
      );
    }
  });
  it("uses the exact device topic", () => {
    expect(createBridgeRequestsTopic("bridge-fixture")).toBe(
      "fleet/v1/devices/bridge-fixture/bridge-requests",
    );
    expect(parseMqttTopic(createBridgeRequestsTopic("bridge-fixture"))).toEqual(
      { deviceId: "bridge-fixture", kind: "bridge-requests" },
    );
    expect(() => createBridgeRequestsTopic("+")).toThrow();
  });
});
