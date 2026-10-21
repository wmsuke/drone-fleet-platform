import { describe, expect, it } from "vitest";
import {
  otaRequestMessageSchema,
  otaEventMessageSchema,
  otaReceiptMessageSchema,
  otaFenceSchema,
  receivedOtaEventSchema,
  parseOtaMessage,
  serializeOtaEvent,
  otaEventContextError,
  createOtaEventsTopic,
  createOtaRequestsTopic,
  createOtaReceiptsTopic,
  type OtaApplyRequest,
  type OtaEventMessage,
} from "../src/index.js";

const id = "90c85252-a66e-4f6d-8d4b-137a4a1b2e35";
const other = "4f832c11-7133-40af-8b8b-b44093b012c6";
const release = {
  releaseId: id,
  digest: "a".repeat(64),
  version: "0.1.0",
  buildId: "build-1",
};
const scope = {
  schemaVersion: 1 as const,
  deviceId: "drone-001",
  deploymentId: id,
  stageId: id,
  targetId: id,
  attemptId: id,
  fence: "9007199254740993",
  release,
};
const apply: OtaApplyRequest = {
  ...scope,
  type: "APPLY_RELEASE",
  commandId: id,
  purpose: "APPLY",
  createdAt: "2026-10-21T00:00:00.000Z",
  expiresAt: "2026-10-21T00:05:00.000Z",
  resultDeadline: "2026-10-21T00:10:00.000Z",
  evaluationVersion: "ota-health-v1",
};
const base = {
  ...scope,
  eventId: id,
  sequence: 0,
  applyCommandId: id,
  supervisorBootId: other,
  timestamp: "2026-10-21T00:00:01.000Z",
};
const progress = {
  ...base,
  type: "PROGRESS" as const,
  requestType: "APPLY_RELEASE" as const,
  state: "RECEIVED" as const,
  commandId: id,
  downloadedBytes: 0,
  reason: null,
};
const running = { release, bootId: id };
const version = { ...base, type: "VERSION" as const, running };
const health = {
  ...base,
  type: "HEALTH" as const,
  running,
  queryCommandId: other,
  challengeId: other,
  measuredAt: base.timestamp,
  sampleMonotonicMs: 1000,
  sampleAgeMs: 0,
  checks: {
    eventLoop: "PASSED",
    telemetry: "PASSED",
    sqlite: "PASSED",
    commandReady: "PASSED",
    mqtt: "PASSED",
    subscriptions: "PASSED",
    receipts: "PASSED",
  },
};
const receipt = {
  ...scope,
  eventId: id,
  payloadHash: "b".repeat(64),
  status: "STORED",
  receivedAt: "2026-10-21T00:00:02.000Z",
  storedAt: "2026-10-21T00:00:03.000Z",
};

describe("OTA v1 requests", () => {
  it("accepts apply/rollback/stop/query without changing existing commands", () => {
    expect(otaRequestMessageSchema.parse(apply)).toEqual(apply);
    expect(
      otaRequestMessageSchema.safeParse({ ...apply, purpose: "ROLLBACK" })
        .success,
    ).toBe(true);
    const control = {
      ...scope,
      commandId: other,
      applyCommandId: id,
      createdAt: apply.createdAt,
      evaluationVersion: apply.evaluationVersion,
    };
    for (const request of [
      {
        ...control,
        type: "STOP_UPDATE",
        commandId: other,
        applyCommandId: id,
        expiresAt: "2026-10-21T00:00:30.000Z",
        resultDeadline: "2026-10-21T00:01:00.000Z",
      },
      {
        ...control,
        type: "QUERY_STATE",
        commandId: other,
        applyCommandId: id,
        expiresAt: "2026-10-21T00:00:15.000Z",
        resultDeadline: "2026-10-21T00:00:15.000Z",
        challengeId: null,
      },
    ])
      expect(otaRequestMessageSchema.parse(request)).toEqual(request);
  });
  it.each(["deploymentId", "stageId", "targetId", "attemptId", "commandId"])(
    "rejects invalid %s",
    (field) =>
      expect(
        otaRequestMessageSchema.safeParse({ ...apply, [field]: "not-a-uuid" })
          .success,
      ).toBe(false),
  );
  it.each([
    { deviceId: "drone/+" },
    { type: "REBOOT" },
    { schemaVersion: 2 },
    { purpose: "RETRY" },
    { actor: "admin" },
    { url: "http://example.com" },
    { expiresAt: "2026-10-21T00:05:00.001Z" },
    { resultDeadline: apply.expiresAt },
    { createdAt: "2026-02-30T00:00:00.000Z" },
    { createdAt: "2026-10-21T00:00:00+09:00" },
    { createdAt: "2026-10-21T00:00:00Z" },
    { release: { ...release, releaseId: "bad" } },
    { release: { ...release, digest: "A".repeat(64) } },
    { release: { ...release, version: "01.2.3" } },
    { release: { ...release, version: "latest" } },
    { release: { ...release, buildId: "../main" } },
  ])("rejects invalid request %j", (change) =>
    expect(
      otaRequestMessageSchema.safeParse({ ...apply, ...change }).success,
    ).toBe(false),
  );
  it.each([
    "0",
    "-1",
    "01",
    "1.0",
    "1e3",
    "9223372036854775808",
    "abc",
    "",
    " 1",
  ])("rejects fence %s without throwing from safeParse", (fence) =>
    expect(otaFenceSchema.safeParse(fence).success).toBe(false),
  );
  it("preserves the maximum signed int64 without JS number rounding", () =>
    expect(otaFenceSchema.parse("9223372036854775807")).toBe(
      "9223372036854775807",
    ));
});

describe("OTA evidence and receipts", () => {
  it.each([
    "RECEIVED",
    "DOWNLOADING",
    "VERIFIED",
    "QUIESCING",
    "SWITCHING",
    "BOOTING",
    "HEALTH_CHECKING",
    "APPLIED",
    "FAILED",
    "UNCERTAIN",
    "STOPPED",
  ])(
    "accepts factual progress %s without claiming evaluated success",
    (state) => {
      const message = {
        ...progress,
        state,
        requestType: state === "STOPPED" ? "STOP_UPDATE" : "APPLY_RELEASE",
        reason: ["FAILED", "UNCERTAIN"].includes(state)
          ? "RESULT_UNKNOWN"
          : null,
        commandId: state === "STOPPED" ? other : id,
      };
      expect(otaEventMessageSchema.parse(message)).toEqual(message);
    },
  );
  it("separates child version/boot, health and state query from progress", () => {
    const stopReceipt = {
      ...progress,
      requestType: "STOP_UPDATE",
      commandId: other,
    };
    expect(otaEventMessageSchema.parse(stopReceipt)).toEqual(stopReceipt);
    expect(
      otaEventMessageSchema.safeParse({ ...stopReceipt, state: "APPLIED" })
        .success,
    ).toBe(false);
    for (const message of [
      version,
      health,
      {
        ...base,
        type: "STATE",
        queryCommandId: other,
        state: "UNCERTAIN",
        running: null,
      },
    ])
      expect(otaEventMessageSchema.parse(message)).toEqual(message);
    expect(
      otaEventMessageSchema.safeParse({
        ...health,
        checks: { ...health.checks, sqlite: "FAILED" },
      }).success,
    ).toBe(true);
  });
  it.each([
    { state: "SUCCEEDED" },
    { state: "FAILED" },
    { reason: "RESULT_UNKNOWN" },
    { sequence: -1 },
    { sequence: 1.1 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { eventId: "bad" },
    { receivedAt: base.timestamp },
    { timestamp: "yesterday" },
    { commandId: other },
    { state: "STOPPED" },
  ])("rejects malformed progress %j", (change) =>
    expect(
      otaEventMessageSchema.safeParse({ ...progress, ...change }).success,
    ).toBe(false),
  );
  it.each([
    { challengeId: "bad" },
    { queryCommandId: id },
    { sampleAgeMs: 5001 },
    { sampleMonotonicMs: -1 },
    { measuredAt: "2026-10-21T00:00:01.001Z" },
    { measuredAt: "2026-10-20T23:59:55.999Z" },
    { running: { ...running, bootId: "bad" } },
    { running: { ...running, release: { ...release, version: "v1" } } },
    { checks: { eventLoop: "PASSED" } },
  ])("rejects invalid health/version/time %j", (change) =>
    expect(
      otaEventMessageSchema.safeParse({ ...health, ...change }).success,
    ).toBe(false),
  );
  it("server receipt checks committed payload identity and separate server times", () => {
    expect(otaReceiptMessageSchema.parse(receipt)).toEqual(receipt);
    for (const change of [
      { payloadHash: "bad" },
      { status: "ACKNOWLEDGED" },
      { storedAt: base.timestamp },
      { timestamp: base.timestamp },
    ])
      expect(
        otaReceiptMessageSchema.safeParse({ ...receipt, ...change }).success,
      ).toBe(false);
    expect(
      receivedOtaEventSchema.parse({
        event: progress,
        receivedAt: "2026-10-20T00:00:00.000Z",
      }),
    ).toHaveProperty("receivedAt");
  });
  it("uses deterministic payload bytes, excludes receive metadata and keeps changed evidence distinct", () => {
    const reordered = Object.fromEntries(
      Object.entries(progress).reverse(),
    ) as typeof progress;
    expect(serializeOtaEvent(progress)).toBe(serializeOtaEvent(reordered));
    expect(serializeOtaEvent({ ...progress, sequence: 1 })).not.toBe(
      serializeOtaEvent(progress),
    );
    expect(serializeOtaEvent(progress)).not.toContain("receivedAt");
  });
  it.each([
    "deviceId",
    "deploymentId",
    "stageId",
    "targetId",
    "attemptId",
    "applyCommandId",
    "fence",
  ])("detects mixed scope %s", (field) => {
    expect(
      otaEventContextError(
        {
          ...progress,
          [field]:
            field === "deviceId"
              ? "drone-002"
              : field === "fence"
                ? "2"
                : other,
        },
        apply,
      ),
    ).toBe("ATTEMPT_MISMATCH");
  });
  it.each(["releaseId", "digest", "version", "buildId"])(
    "detects unexpected release %s in envelope and actual running report",
    (field) => {
      const changed = {
        ...release,
        [field]:
          field === "digest"
            ? "b".repeat(64)
            : field === "version"
              ? "0.2.0"
              : other,
      };
      expect(
        otaEventContextError({ ...version, release: changed }, apply),
      ).toBe("RELEASE_MISMATCH");
      expect(
        otaEventContextError(
          { ...version, running: { ...running, release: changed } },
          apply,
        ),
      ).toBe("RELEASE_MISMATCH");
      expect(otaEventContextError(version, apply)).toBeNull();
    },
  );
  it("does not infer order, freshness or success from a single schema-valid message", () => {
    const late: OtaEventMessage = {
      ...progress,
      timestamp: "2026-10-22T00:00:00.000Z",
    };
    expect(otaEventMessageSchema.safeParse(late).success).toBe(true);
    expect(otaEventContextError(late, apply)).toBeNull();
  });
});

describe("OTA routing uses the same local/AWS contract", () => {
  it.each([
    [createOtaRequestsTopic, apply],
    [createOtaEventsTopic, progress],
    [createOtaReceiptsTopic, receipt],
  ] as const)(
    "validates topic identity, kind and MQTT flags",
    (topic, message) => {
      expect(
        parseOtaMessage(topic("drone-001"), message, { qos: 1, retain: false }),
      ).toEqual(message);
      expect(() =>
        parseOtaMessage(topic("drone-002"), message, { qos: 1, retain: false }),
      ).toThrow();
      expect(() =>
        parseOtaMessage(topic("drone-001"), message, { qos: 1, retain: true }),
      ).toThrow();
      expect(() =>
        parseOtaMessage(topic("drone-001"), message, { qos: 0, retain: false }),
      ).toThrow();
      expect(() =>
        parseOtaMessage("fleet/v1/devices/drone-001/commands", message, {
          qos: 1,
          retain: false,
        }),
      ).toThrow();
    },
  );
  it("rejects invalid deviceId during topic generation", () => {
    for (const topic of [
      createOtaRequestsTopic,
      createOtaEventsTopic,
      createOtaReceiptsTopic,
    ])
      expect(() => topic("drone/#")).toThrow();
    expect(() =>
      parseOtaMessage(createOtaEventsTopic("drone-001"), apply, {
        qos: 1,
        retain: false,
      }),
    ).toThrow();
  });
});
