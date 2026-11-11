import { createHash } from "node:crypto";
import { canonicalBridgeJson } from "@drone-fleet/protocol";
import { configuration } from "../../../packages/protocol/test/fixtures/bridge.mjs";
import { healthMessage } from "../../../packages/protocol/test/fixtures/bridge-health.mjs";
import { observation } from "../../../packages/protocol/test/fixtures/ros-observations.mjs";
import { actionFixtures } from "../../../packages/protocol/test/fixtures/bridge-actions.mjs";
import { cancelFixtures } from "../../../packages/protocol/test/fixtures/bridge-cancels.mjs";
import {
  rosConfigurationSchema,
  rosHealthSchema,
  rosExecutionSchema,
  rosCancelSchema,
  rosObservationSchema,
} from "../src/ros-api.js";

export const deviceId = "ros-fixture";
export const commandId = "c4444444-4444-4444-8444-444444444444";
export const base = "http://api.example.test";
export function rosFixtures() {
  const time = new Date().toISOString();
  const digest = (value) =>
    createHash("sha256").update(canonicalBridgeJson(value)).digest("hex");
  const cfg = configuration(digest, deviceId);
  cfg.bridge.version = "0.5.0";
  cfg.adapter.version = "0.4.0";
  const configurationId = digest(cfg);
  const config = rosConfigurationSchema.parse({
    reported: {
      configurationId,
      reportSequence: 1,
      receivedAt: time,
      configuration: cfg,
    },
    fresh: true,
    ready: true,
    supportedOperations: ["RETURN_HOME"],
    matchesDesired: null,
    operationReason: "READY",
  });
  const message = {
    ...healthMessage,
    deviceId,
    configurationId,
    timestamp: time,
    sequence: 2,
    ready: true,
    reason: "READY",
    rosAvailable: true,
    observationsFresh: true,
    serverInstanceId: cfg.serverInstanceId,
  };
  const health = rosHealthSchema.parse({
    latest: {
      eventId: message.eventId,
      message,
      receivedAt: time,
      disposition: "CURRENT",
    },
    fresh: true,
    ready: true,
    humanReviewRequired: false,
    physicalStopConfirmed: false,
    events: [],
  });
  const quality = { ...observation.payload.quality.battery, receivedAt: time };
  const sample = rosObservationSchema.parse({
    receivedAt: time,
    message: {
      ...observation,
      deviceId,
      timestamp: time,
      payload: {
        ...observation.payload,
        battery: 80,
        position: {
          ...observation.payload.position,
          frameId: cfg.namespace.slice(1) + "/map",
        },
        quality: {
          ...observation.payload.quality,
          battery: quality,
          position: quality,
        },
      },
    },
  });
  const progress = actionFixtures.find(
    (f) => f.message.kind === "FEEDBACK",
  ).message;
  const execution = rosExecutionSchema.parse({
    command: {
      commandId,
      deviceId,
      status: "ACKNOWLEDGED",
      executionStatus: "RUNNING",
    },
    target: {
      goalId: progress.goalId,
      acceptedAt: time,
      stopConfirmed: false,
      notStarted: false,
      conflicted: false,
      resultDeadline: time,
    },
    configuration: cfg,
    recovery: {
      humanReviewRequired: false,
      automaticResubmit: false,
      reason: null,
      evidenceEventId: null,
    },
    events: [
      {
        eventId: progress.eventId,
        receivedAt: time,
        disposition: "APPLIED",
        message: { ...progress, deviceId, configurationId },
      },
    ],
  });
  const request = {
    ...cancelFixtures[0].message,
    deviceId,
    commandId,
    goalId: progress.goalId,
    serverInstanceId: cfg.serverInstanceId,
    configurationId,
  };
  const cancellation = rosCancelSchema.parse({
    cancelId: request.cancelId,
    commandId,
    deviceId,
    request,
    phase: "ACCEPTED",
    assessment: "PENDING",
    terminalStatus: "RUNNING",
    stopConfirmation: "UNKNOWN",
    humanReviewRequired: false,
    intervention: {
      interventionId: request.cancelId,
      reason: request.reason,
      actorKind: "anonymous",
      startedAt: time,
      finishedAt: null,
      durationMs: null,
      cost: null,
    },
    events: [],
  });
  const history = [
    {
      commandId,
      deviceId,
      type: "RETURN_HOME",
      status: "ACKNOWLEDGED",
      createdAt: time,
      sentAt: time,
      acknowledgementReceivedAt: time,
      timedOutAt: null,
      executionStatus: "RUNNING",
    },
  ];
  return { config, health, sample, execution, cancellation, history };
}
