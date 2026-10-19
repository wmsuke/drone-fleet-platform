import type { AlertPolicy } from "./config.js";
export type Kind = "OFFLINE" | "LOW_BATTERY" | "COMMAND_OUTCOME";
export interface Decision {
  kind: Kind;
  action: "raise" | "observe" | "resolve";
  at: number;
  reason: string;
  evidence: Record<string, string | number | null>;
}
export interface DeviceFact {
  key: string;
  receivedAt: number;
  deviceAt: number;
  battery?: number;
  session?: string;
  sequence?: number;
}
export interface DeviceState {
  revision: number;
  lowSince: number | null;
  highSince: number | null;
  recoverySince: number | null;
  batteryDeviceAt: number | null;
  batteryReceivedAt: number | null;
  freshDeviceAt: number | null;
  freshReceivedAt: number | null;
  sessions: Record<string, number>;
  seen: Record<string, number>;
}
export function initialDeviceState(revision: number): DeviceState {
  return {
    revision,
    lowSince: null,
    highSince: null,
    recoverySince: null,
    batteryDeviceAt: null,
    batteryReceivedAt: null,
    freshDeviceAt: null,
    freshReceivedAt: null,
    sessions: {},
    seen: {},
  };
}
export function evaluateDevice(input: {
  online: boolean;
  changedAt: number;
  revision: number;
  now: number;
  facts: DeviceFact[];
  previous: DeviceState | null;
  policy: AlertPolicy;
}) {
  const { now, policy: p } = input;
  const state: DeviceState = input.previous
    ? structuredClone(input.previous)
    : initialDeviceState(input.revision);
  const decisions: Decision[] = [];
  if (state.revision !== input.revision || !input.online) {
    state.lowSince = state.highSince = state.recoverySince = null;
    state.revision = input.revision;
  }
  state.seen = Object.fromEntries(
    Object.entries(state.seen).filter(
      ([, received]) => received >= now - p.freshMs,
    ),
  );
  if (!input.online) {
    if (now - input.changedAt >= p.offlineHoldMs)
      decisions.push({
        kind: "OFFLINE",
        action: "raise",
        at: now,
        reason: "OFFLINE",
        evidence: { offlineSince: input.changedAt },
      });
    return { state, decisions };
  }
  for (const fact of [...input.facts].sort(
    (a, b) => a.receivedAt - b.receivedAt || a.key.localeCompare(b.key),
  )) {
    if (state.seen[fact.key] !== undefined) continue;
    if (fact.receivedAt > now) continue;
    state.seen[fact.key] = fact.receivedAt;
    if (
      fact.receivedAt < input.changedAt ||
      now - fact.receivedAt > p.freshMs ||
      now - fact.deviceAt > p.freshMs
    )
      continue;
    if (fact.deviceAt - now > p.futureMs) {
      state.lowSince = state.highSince = state.recoverySince = null;
      continue;
    }
    if (fact.battery !== undefined) {
      const session = fact.session ?? "legacy";
      if (
        (state.sessions[session] ?? -1) >= fact.sequence! ||
        (state.batteryDeviceAt !== null &&
          fact.deviceAt <= state.batteryDeviceAt)
      )
        continue;
      state.sessions[session] = fact.sequence!;
      if (
        state.batteryReceivedAt !== null &&
        fact.receivedAt <= state.batteryReceivedAt
      ) {
        state.lowSince = state.highSince = null;
        continue;
      }
      const gap =
        state.batteryReceivedAt === null ||
        state.batteryDeviceAt === null ||
        fact.receivedAt - state.batteryReceivedAt <= 0 ||
        fact.receivedAt - state.batteryReceivedAt > p.gapMs ||
        fact.deviceAt - state.batteryDeviceAt > p.gapMs;
      if (gap) state.lowSince = state.highSince = null;
      state.batteryReceivedAt = fact.receivedAt;
      state.batteryDeviceAt = fact.deviceAt;
      state.lowSince =
        fact.battery <= p.lowBattery
          ? (state.lowSince ?? fact.receivedAt)
          : null;
      state.highSince =
        fact.battery >= p.recoveredBattery
          ? (state.highSince ?? fact.receivedAt)
          : null;
      const evidence = {
        battery: fact.battery,
        deviceTimestamp: fact.deviceAt,
        receivedAt: fact.receivedAt,
      };
      if (
        state.lowSince !== null &&
        fact.receivedAt - state.lowSince >= p.batteryHoldMs
      )
        decisions.push({
          kind: "LOW_BATTERY",
          action: "raise",
          at: fact.receivedAt,
          reason: "LOW_BATTERY",
          evidence,
        });
      else if (
        state.highSince !== null &&
        fact.receivedAt - state.highSince >= p.recoveryHoldMs
      )
        decisions.push({
          kind: "LOW_BATTERY",
          action: "resolve",
          at: fact.receivedAt,
          reason: "BATTERY_RECOVERED",
          evidence,
        });
      else
        decisions.push({
          kind: "LOW_BATTERY",
          action: "observe",
          at: fact.receivedAt,
          reason: "LOW_BATTERY",
          evidence,
        });
    }
    if (state.freshDeviceAt !== null && fact.deviceAt <= state.freshDeviceAt)
      continue;
    if (
      state.freshReceivedAt !== null &&
      fact.receivedAt <= state.freshReceivedAt
    ) {
      state.recoverySince = null;
      continue;
    }
    if (
      state.freshReceivedAt === null ||
      fact.receivedAt - state.freshReceivedAt <= 0 ||
      fact.receivedAt - state.freshReceivedAt > p.gapMs ||
      (state.freshDeviceAt !== null &&
        fact.deviceAt - state.freshDeviceAt > p.gapMs)
    )
      state.recoverySince = null;
    state.recoverySince ??= fact.receivedAt;
    state.freshReceivedAt = fact.receivedAt;
    state.freshDeviceAt = fact.deviceAt;
    if (fact.receivedAt - state.recoverySince >= p.recoveryHoldMs)
      decisions.push({
        kind: "OFFLINE",
        action: "resolve",
        at: fact.receivedAt,
        reason: "ONLINE_RECOVERED",
        evidence: { onlineSince: state.recoverySince },
      });
  }
  if (
    state.batteryReceivedAt === null ||
    now - state.batteryReceivedAt > p.gapMs
  )
    state.lowSince = state.highSince = null;
  if (state.freshReceivedAt === null || now - state.freshReceivedAt > p.gapMs)
    state.recoverySince = null;
  return { state, decisions };
}
export function commandOutcome(
  command: {
    status: string;
    executionStatus: string;
    acknowledgementReceivedAt: Date | null;
  },
  deadline: number,
  now: number,
): string | null {
  if (command.executionStatus === "SUCCEEDED") return "SUCCEEDED";
  if (command.executionStatus === "FAILED") return "EXECUTION_FAILED";
  if (command.executionStatus === "UNCERTAIN") return "UNCERTAIN";
  if (command.status === "EXPIRED") return "EXPIRED";
  if (now >= deadline) return "UNRESPONSIVE";
  if (
    command.executionStatus === "RUNNING" ||
    command.acknowledgementReceivedAt !== null
  )
    return null;
  if (command.status === "FAILED") return "DELIVERY_FAILED";
  if (command.status === "TIMED_OUT") return "UNRESPONSIVE";
  return null;
}
