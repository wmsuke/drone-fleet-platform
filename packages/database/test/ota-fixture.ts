import { randomUUID } from "node:crypto";
import type { OtaApplyRequest, OtaEventMessage } from "@drone-fleet/protocol";
import type { OtaEvidence } from "../src/ota-evaluation.js";

export function otaFixture(base = Date.now()) {
  const at = (ms: number) => new Date(base + ms);
  const apply: OtaApplyRequest = {
    schemaVersion: 1,
    type: "APPLY_RELEASE",
    purpose: "APPLY",
    deviceId: "ota-evaluation-test",
    deploymentId: randomUUID(),
    stageId: randomUUID(),
    targetId: randomUUID(),
    attemptId: randomUUID(),
    commandId: randomUUID(),
    fence: "1",
    release: {
      releaseId: randomUUID(),
      digest: "a".repeat(64),
      version: "0.2.0",
      buildId: "candidate",
    },
    createdAt: at(0).toISOString(),
    expiresAt: at(300000).toISOString(),
    resultDeadline: at(600000).toISOString(),
    evaluationVersion: "ota-health-v1",
  };
  const bootId = randomUUID(),
    supervisorBootId = randomUUID();
  const events: OtaEventMessage[] = [];
  const times: number[] = [];
  function add(detail: Record<string, unknown>, time: number) {
    const scope = Object.fromEntries(
      Object.entries(apply).filter(
        ([key]) =>
          ![
            "purpose",
            "type",
            "createdAt",
            "expiresAt",
            "resultDeadline",
            "evaluationVersion",
            "commandId",
          ].includes(key),
      ),
    );
    const e = {
      ...scope,
      applyCommandId: apply.commandId,
      eventId: randomUUID(),
      sequence: events.length,
      timestamp: at(time).toISOString(),
      supervisorBootId,
      ...detail,
    } as OtaEventMessage;
    events.push(e);
    times.push(time);
    return e;
  }
  const progress = (state: string, time: number) =>
    add(
      {
        type: "PROGRESS",
        requestType: "APPLY_RELEASE",
        state,
        commandId: apply.commandId,
        downloadedBytes: 128,
        reason: null,
      },
      time,
    );
  progress("RECEIVED", 0);
  progress("DOWNLOADING", 1000);
  progress("VERIFIED", 2000);
  progress("QUIESCING", 3000);
  progress("SWITCHING", 4000);
  progress("BOOTING", 4100);
  add({ type: "VERSION", running: { release: apply.release, bootId } }, 5000);
  progress("HEALTH_CHECKING", 6000);
  for (let i = 0; i < 13; i++)
    add(
      {
        type: "HEALTH",
        running: { release: apply.release, bootId },
        queryCommandId: randomUUID(),
        challengeId: randomUUID(),
        measuredAt: at(10000 + i * 5000 - 10).toISOString(),
        sampleMonotonicMs: 10000 + i * 5000,
        sampleAgeMs: 10,
        checks: {
          eventLoop: "PASSED",
          telemetry: "PASSED",
          sqlite: "PASSED",
          commandReady: "PASSED",
          mqtt: "PASSED",
          subscriptions: "PASSED",
          receipts: "PASSED",
        },
      },
      10000 + i * 5000,
    );
  progress("APPLIED", 71000);
  const rows: OtaEvidence[] = events.map((event, i) => ({
    eventId: event.eventId,
    sequence: BigInt(event.sequence),
    payload: event,
    receivedAt: at(times[i]!),
    storedAt: at(times[i]!),
    acceptance: "ACCEPTED",
    reason: null,
  }));
  return { apply, bootId, supervisorBootId, events, rows, at };
}
