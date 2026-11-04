import { randomUUID } from "node:crypto";
import {
  deploymentSchema,
  releaseSchema,
  type Deployment,
} from "../src/ota-api.js";

export function otaFixture(count = 2) {
  const now = Date.now(),
    at = (offset = 0) => new Date(now + offset).toISOString();
  const old = {
    releaseId: randomUUID(),
    version: "0.4.0",
    buildId: "baseline",
    digest: "a".repeat(64),
  };
  const next = {
    releaseId: randomUUID(),
    version: "0.5.0",
    buildId: "candidate",
    digest: "b".repeat(64),
  };
  const manifest = {
    ...next,
    schemaVersion: 1,
    application: "simulator",
    platform: "linux-arm64",
    size: 1024,
    rollbackCompatible: true,
    stateSchemaRange: "1.0.0",
    nodeRange: ">=22.13.0 <23",
    supervisorRange: "^1.0.0",
    otaProtocolRange: "^1.0.0",
    entrypoint: "app/main.mjs",
    healthContractVersion: "ota-health-v1",
  };
  const release = releaseSchema.parse({
    ...next,
    envelope: { manifest },
    application: "simulator",
    platform: "linux-arm64",
    verification: "VERIFIED",
    verifiedAt: at(),
  });
  const stageIds = count > 1 ? [randomUUID(), randomUUID()] : [randomUUID()];
  const targets = Array.from({ length: count }, (_, n) => ({
    targetId: randomUUID(),
    stageId: n === 0 ? stageIds[0] : stageIds[1],
    deviceId: `drone-${String(n + 1).padStart(3, "0")}`,
    status: "QUEUED",
    snapshot: old,
    current: { ...old, bootId: randomUUID(), observedAt: at() },
    observation: null,
    attempts: [
      {
        attemptId: randomUUID(),
        commandId: randomUUID(),
        ordinal: 1,
        purpose: "APPLY",
        previousAttemptId: null,
        fence: "1",
        deliveryStatus: "HELD",
        applicationStatus: null,
        evaluationStatus: "PENDING",
        startedAt: null,
        expiresAt: null,
        resultDeadline: null,
        freshHealth: false,
        stop: null,
        events: [],
        eventsTruncated: false,
        evaluations: [],
        rejections: [],
      },
    ],
  }));
  const data = deploymentSchema.parse({
    deploymentId: randomUUID(),
    releaseId: next.releaseId,
    status: "ACCEPTED",
    targetCount: count,
    createdAt: at(),
    evaluatedAt: at(),
    releaseSnapshot: { manifest },
    policy: {
      stop: { failureRate: 0.1, uncertain: "IMMEDIATE" },
      health: { samples: 13, durationSeconds: 60 },
    },
    stages: stageIds.map((stageId, n) => ({
      stageId,
      position: n,
      status: n === 0 ? "AWAITING_APPROVAL" : "PENDING",
      deviceIds: targets
        .filter((t) => t.stageId === stageId)
        .map((t) => t.deviceId),
      denominator: n === 0 ? 1 : count - 1,
      counts: { QUEUED: n === 0 ? 1 : count - 1 },
    })),
    targets,
    control: null,
    recoveries: [],
    interventionSummary: {
      recordedCount: 0,
      requiredApprovalCount: 0,
      faultResponseCount: 0,
      openReviewCount: 0,
      legacyOperationCount: 0,
      excludesAutonomousCompletion: false,
    },
  });
  function failed(kind: "RETRY" | "ROLLBACK" = "RETRY") {
    data.status = "PAUSED";
    data.control = { stoppedAt: at(-5000), stopReason: "FAILURE_THRESHOLD" };
    data.stages[0]!.status = "PAUSED";
    const t = data.targets[0]!,
      a = t.attempts[0]!;
    t.status = "FAILED";
    a.evaluationStatus = "FAILED";
    a.applicationStatus = "FAILED";
    a.deliveryStatus = "ACKNOWLEDGED";
    a.startedAt = at(-80000);
    a.expiresAt = at(220000);
    a.resultDeadline = at(520000);
    const running = {
        release: kind === "RETRY" ? old : next,
        bootId: t.current!.bootId,
      },
      supervisorBootId = randomUUID();
    t.current = {
      ...running.release,
      bootId: running.bootId,
      observedAt: at(),
    };
    t.observation = {
      receivedAt: at(),
      payload: {
        schemaVersion: 1,
        type: "INVENTORY",
        deviceId: t.deviceId,
        eventId: randomUUID(),
        sequence: 1,
        supervisorBootId,
        timestamp: at(),
        measuredAt: at(),
        sampleAgeMs: 0,
        running,
        capabilities: {
          application: "simulator",
          platform: "linux-arm64",
          nodeVersion: "22.13.0",
          otaProtocolVersion: "1.0.0",
          supervisorVersion: "1.0.0",
          stateSchemaVersion: "1.0.0",
          healthContractVersion: "ota-health-v1",
        },
        readiness: {
          eventLoop: "PASSED",
          telemetry: "PASSED",
          sqlite: "PASSED",
          commandReady: "PASSED",
          mqtt: "PASSED",
          subscriptions: "PASSED",
          receipts: "PASSED",
        },
        recovery: {
          knownGood: old,
          attemptId: a.attemptId,
          phase: "FAILED",
          downloadedBytes: 256,
          detectedAt: at(-10000),
          budgetDeadline: at(890000),
        },
      },
    };
    const progressId = randomUUID();
    a.events = [
      {
        eventId: randomUUID(),
        sequence: "1",
        acceptance: "ACCEPTED",
        reason: null,
        storedAt: at(),
        occurredAt: at(),
        receivedAt: at(),
        payload: { type: "STATE", state: "FAILED", supervisorBootId, running },
      },
      {
        eventId: progressId,
        sequence: "0",
        acceptance: "ACCEPTED",
        reason: null,
        storedAt: at(-10000),
        occurredAt: at(-10000),
        receivedAt: at(-10000),
        payload: {
          type: "PROGRESS",
          state: "FAILED",
          requestType: "APPLY_RELEASE",
          reason: kind === "RETRY" ? "DOWNLOAD_FAILED" : "HEALTH_FAILED",
          downloadedBytes: 256,
        },
      },
    ];
    a.evaluations = [
      {
        evaluationId: randomUUID(),
        revision: 1,
        status: "FAILED",
        reason: "DEVICE_FAILURE",
        evaluatedAt: at(-10000),
        evidence: [progressId],
      },
    ];
    return data;
  }
  return { data, release, now, at, old, next, failed };
}
export function intervention(data: Deployment, open = false) {
  return {
    interventionId: randomUUID(),
    kind: open ? "HUMAN_REVIEW" : "STAGE_APPROVAL",
    category: open ? "FAULT_RESPONSE" : "REQUIRED_APPROVAL",
    reason: "LOCAL_DEMO",
    actorKind: "anonymous",
    actorId: null,
    operationResult: open ? "OPEN" : "ACCEPTED",
    startedAt: data.createdAt,
    finishedAt: open ? null : data.createdAt,
    durationMs: null,
    durationSource: null,
    cost: null,
    auditEventId: randomUUID(),
    completionAuditEventId: null,
    completionReason: null,
    recoveryId: null,
    resolutionRecoveryId: null,
    scope: data.targets.map((t) => ({
      targetId: t.targetId,
      attemptId: t.attempts[0]!.attemptId,
    })),
    recovery: null,
  };
}
