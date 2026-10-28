import {
  otaEventMessageSchema,
  otaEventContextError,
  type OtaApplyRequest,
  type OtaEventMessage,
} from "@drone-fleet/protocol";

export interface OtaEvidence {
  eventId: string;
  sequence: bigint;
  payload: Record<string, unknown>;
  receivedAt: Date;
  storedAt: Date;
  acceptance: string;
  reason: string | null;
}
export interface OtaVerdict {
  status: "PENDING" | "OBSERVING" | "SUCCEEDED" | "FAILED" | "UNCERTAIN";
  reason: string;
  evidence: string[];
}
export function evaluateOta(
  apply: OtaApplyRequest,
  rows: OtaEvidence[],
  now: Date,
  previousSuccess?: OtaVerdict,
): OtaVerdict {
  const result = (
    status: OtaVerdict["status"],
    reason: string,
    evidence: string[] = [],
  ): OtaVerdict => ({ status, reason, evidence });
  const ordered = [...rows].sort((a, b) =>
    a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0,
  );
  const eligible = ordered.filter((r) => r.acceptance === "ACCEPTED");
  const parsed = eligible.map((row) => ({
    row,
    event: otaEventMessageSchema.parse(row.payload),
  }));
  const mismatch = parsed.filter(
    (x) => otaEventContextError(x.event, apply) !== null,
  );
  if (mismatch.length)
    return result(
      "UNCERTAIN",
      "CONFLICTING_EVIDENCE",
      mismatch.map((x) => x.row.eventId),
    );
  const conflicting = ordered.filter((r) =>
    [
      "RELEASE_MISMATCH",
      "EVENT_CONFLICT",
      "CONTRADICTORY_STATE",
      "BOOT_MISMATCH",
      "LATE_HEALTH_FAILURE",
    ].includes(r.reason ?? ""),
  );
  if (conflicting.length)
    return result(
      "UNCERTAIN",
      "CONFLICTING_EVIDENCE",
      conflicting.map((r) => r.eventId),
    );
  const progress = parsed.filter(
    (
      x,
    ): x is typeof x & {
      event: Extract<OtaEventMessage, { type: "PROGRESS" }>;
    } => x.event.type === "PROGRESS" && x.event.requestType === "APPLY_RELEASE",
  );
  const terminal = new Set(
    progress
      .map((x) => x.event.state)
      .filter((s) => ["APPLIED", "FAILED", "UNCERTAIN"].includes(s)),
  );
  if (terminal.size > 1)
    return result(
      "UNCERTAIN",
      "CONTRADICTORY_TERMINAL",
      progress
        .filter((x) => terminal.has(x.event.state))
        .map((x) => x.row.eventId),
    );
  const negative = parsed.filter(
    (x) =>
      (x.event.type === "PROGRESS" &&
        ["FAILED", "UNCERTAIN", "STOPPED"].includes(x.event.state)) ||
      (x.event.type === "HEALTH" &&
        Object.values(x.event.checks).includes("FAILED")) ||
      (x.event.type === "STATE" &&
        ["FAILED", "UNCERTAIN"].includes(x.event.state)),
  );
  if (negative.length)
    return result(
      negative.some(
        (x) =>
          (x.event.type === "PROGRESS" || x.event.type === "STATE") &&
          x.event.state === "UNCERTAIN",
      )
        ? "UNCERTAIN"
        : "FAILED",
      "DEVICE_FAILURE",
      negative.map((x) => x.row.eventId),
    );
  const deadline = Date.parse(apply.resultDeadline);
  const timely = parsed.filter(
    (x) =>
      x.row.receivedAt.getTime() < deadline &&
      x.row.storedAt.getTime() < deadline,
  );
  const versions = timely.filter(
    (
      x,
    ): x is typeof x & {
      event: Extract<OtaEventMessage, { type: "VERSION" }>;
    } => x.event.type === "VERSION",
  );
  const version = versions.at(-1);
  const incomplete = (reason: string) =>
    result(
      now.getTime() >= deadline
        ? "UNCERTAIN"
        : rows.length
          ? "OBSERVING"
          : "PENDING",
      reason,
    );
  const latestVersion = parsed
    .filter(
      (
        x,
      ): x is typeof x & {
        event: Extract<OtaEventMessage, { type: "VERSION" }>;
      } => x.event.type === "VERSION",
    )
    .at(-1);
  const confirmedVersion = parsed.find(
    (x) =>
      x.event.type === "VERSION" &&
      previousSuccess?.evidence.includes(x.row.eventId),
  );
  if (
    previousSuccess &&
    confirmedVersion?.event.type === "VERSION" &&
    latestVersion
  ) {
    if (
      latestVersion.event.running.bootId !==
        confirmedVersion.event.running.bootId ||
      latestVersion.event.supervisorBootId !==
        confirmedVersion.event.supervisorBootId
    )
      return incomplete("BOOT_CHANGED");
    return previousSuccess;
  }
  if (!version) return incomplete("VERSION_UNCONFIRMED");
  const required = [
    "RECEIVED",
    "DOWNLOADING",
    "VERIFIED",
    "QUIESCING",
    "SWITCHING",
    "BOOTING",
    "HEALTH_CHECKING",
    "APPLIED",
  ];
  const facts = required.map((state) =>
    timely.find(
      (x) =>
        x.event.type === "PROGRESS" &&
        x.event.requestType === "APPLY_RELEASE" &&
        x.event.state === state,
    ),
  );
  if (facts.some((x) => !x)) return incomplete("APPLICATION_UNCONFIRMED");
  if (
    Date.parse(facts[0]!.event.timestamp) < Date.parse(apply.createdAt) ||
    Date.parse(facts[0]!.event.timestamp) >= Date.parse(apply.expiresAt)
  )
    return result("UNCERTAIN", "START_UNCONFIRMED", [facts[0]!.row.eventId]);
  const switches = facts[4]!,
    booting = facts[5]!;
  if (
    facts.some(
      (x, i) => i > 0 && x!.event.sequence <= facts[i - 1]!.event.sequence,
    ) ||
    version.event.sequence <= booting.event.sequence
  )
    return result(
      "UNCERTAIN",
      "CONTRADICTORY_STATE",
      facts.map((x) => x!.row.eventId),
    );
  if (
    version.event.supervisorBootId !== switches.event.supervisorBootId ||
    Date.parse(version.event.timestamp) - Date.parse(switches.event.timestamp) <
      0 ||
    Date.parse(version.event.timestamp) - Date.parse(switches.event.timestamp) >
      30000 ||
    version.row.storedAt.getTime() - switches.row.storedAt.getTime() > 30000 ||
    version.row.storedAt < switches.row.storedAt
  )
    return incomplete("STARTUP_UNCONFIRMED");
  // 欠番を成功根拠へ補完しない。遅着で埋まれば再走査で再評価できる。
  let sequence = 0;
  for (const x of ordered) {
    if (x.sequence !== BigInt(sequence++)) return incomplete("SEQUENCE_GAP");
  }
  const health = timely.filter(
    (
      x,
    ): x is typeof x & {
      event: Extract<OtaEventMessage, { type: "HEALTH" }>;
    } =>
      x.event.type === "HEALTH" &&
      x.event.sequence > version.event.sequence &&
      x.event.running.bootId === version.event.running.bootId &&
      x.event.supervisorBootId === version.event.supervisorBootId,
  );
  let window: typeof health = [];
  for (const x of health) {
    const last = window.at(-1);
    if (
      last &&
      (x.event.sampleMonotonicMs <= last.event.sampleMonotonicMs ||
        x.event.sampleMonotonicMs - last.event.sampleMonotonicMs > 10000 ||
        x.row.storedAt.getTime() <= last.row.storedAt.getTime() ||
        x.row.storedAt.getTime() - last.row.storedAt.getTime() > 10000)
    )
      window = [];
    window.push(x);
  }
  const first = window[0],
    last = window.at(-1);
  if (
    !first ||
    !last ||
    window.length < 13 ||
    last.event.sampleMonotonicMs - first.event.sampleMonotonicMs < 60000 ||
    last.row.storedAt.getTime() - first.row.storedAt.getTime() < 60000 ||
    now < last.row.storedAt ||
    now.getTime() - last.row.storedAt.getTime() >= 15000
  )
    return incomplete("HEALTH_INSUFFICIENT");
  return result("SUCCEEDED", "EVIDENCE_CONFIRMED", [
    ...facts.map((x) => x!.row.eventId),
    version.row.eventId,
    ...window.map((x) => x.row.eventId),
  ]);
}
