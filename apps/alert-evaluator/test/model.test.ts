import { describe, expect, it } from "vitest";
import { loadAlertPolicy } from "../src/config.js";
import {
  commandOutcome,
  evaluateDevice,
  type DeviceState,
  type DeviceFact,
  type Decision,
} from "../src/model.js";
const policy = loadAlertPolicy({});
function fixture() {
  let previous: DeviceState | null = null,
    sequence = 0;
  const decisions: Decision[] = [];
  function step(
    now: number,
    battery?: number,
    options: Partial<DeviceFact> = {},
    online = true,
    revision = 1,
  ) {
    const current = sequence++;
    const facts =
      battery === undefined
        ? []
        : [
            {
              key: String(current),
              receivedAt: now,
              deviceAt: now,
              battery,
              sequence: current,
              session: "session-a",
              ...options,
            },
          ];
    const result = evaluateDevice({
      online,
      revision,
      changedAt: -100_000,
      now,
      previous,
      facts,
      policy,
    });
    previous = result.state;
    decisions.push(...result.decisions);
    return result;
  }
  return { step, decisions, state: () => previous! };
}
describe("alert conditions", () => {
  it.each([59_999, 60_000, 60_001])(
    "evaluates actual OFFLINE transition at %ims",
    (elapsed) => {
      const r = evaluateDevice({
        online: false,
        changedAt: 10_000,
        revision: 1,
        now: elapsed + 10_000,
        facts: [],
        previous: null,
        policy,
      });
      expect(r.decisions).toHaveLength(elapsed >= 60_000 ? 1 : 0);
    },
  );
  it.each([19.99, 20, 20.001, 21, 25])(
    "requires sustained low battery at %s",
    (battery) => {
      const f = fixture();
      for (let t = 0; t <= 30_000; t += 5000) f.step(t, battery);
      expect(
        f.decisions.filter(
          (d) => d.kind === "LOW_BATTERY" && d.action === "raise",
        ),
      ).toHaveLength(battery <= 20 ? 1 : 0);
    },
  );
  it.each([5000, 5010, 15_000])("accepts observation gaps of %ims", (gap) => {
    const f = fixture();
    for (let t = 0; t < 30_000 + gap; t += gap) f.step(t, 20);
    expect(
      f.decisions.some((d) => d.kind === "LOW_BATTERY" && d.action === "raise"),
    ).toBe(true);
  });
  it.each(["received", "device"])(
    "breaks the low timer when %s gap is 15001ms",
    (which) => {
      const f = fixture();
      f.step(0, 20, { deviceAt: which === "device" ? -5000 : 0 });
      f.step(which === "received" ? 15_001 : 15_000, 20, {
        deviceAt: which === "received" ? 15_000 : 10_001,
      });
      expect(f.state().lowSince).toBe(which === "received" ? 15_001 : 15_000);
    },
  );
  it("does not generate or resolve from wall-clock passage without fresh samples", () => {
    const f = fixture();
    f.step(0, 20);
    f.step(30_000);
    expect(f.state().lowSince).toBeNull();
    expect(f.decisions.some((d) => d.action === "raise")).toBe(false);
  });
  it("applies hysteresis and requires 30 seconds of recovery evidence", () => {
    const f = fixture();
    for (let t = 0; t <= 30_000; t += 5000) f.step(t, 20);
    for (let t = 35_000; t <= 65_000; t += 5000) f.step(t, 24.99);
    expect(
      f.decisions.some(
        (d) => d.kind === "LOW_BATTERY" && d.action === "resolve",
      ),
    ).toBe(false);
    for (let t = 70_000; t <= 100_000; t += 5000) f.step(t, 25);
    expect(
      f.decisions.filter(
        (d) => d.kind === "LOW_BATTERY" && d.action === "resolve",
      ),
    ).toHaveLength(1);
  });
  it("does not adopt old device timestamps, sequence rollback or a previous session's repeated sequence", () => {
    const f = fixture();
    f.step(0, 20, { sequence: 100 });
    f.step(5000, 99, { sequence: 99 });
    f.step(6000, 99, { deviceAt: 0, sequence: 101, session: "session-b" });
    f.step(7000, 20, { session: "session-b", sequence: 0 });
    f.step(8000, 99, { session: "session-a", sequence: 100 });
    expect(f.state().batteryReceivedAt).toBe(7000);
    expect(f.state().lowSince).toBe(0);
  });
  it("does not reuse observations on replay and restores the same state after restart", () => {
    const fact = {
      key: "1",
      receivedAt: 0,
      deviceAt: 0,
      battery: 20,
      session: "a",
      sequence: 1,
    };
    const input = {
      online: true,
      revision: 1,
      changedAt: 0,
      now: 0,
      facts: [fact],
      policy,
    };
    const first = evaluateDevice({ ...input, previous: null });
    const replayed = evaluateDevice({
      ...input,
      previous: JSON.parse(JSON.stringify(first.state)),
    });
    expect(replayed.decisions).toEqual([]);
    expect(replayed.state).toEqual(first.state);
  });
  it("does not move receipt time backward when an earlier-received observation commits late", () => {
    const f = fixture();
    f.step(10_000, 20, { sequence: 1 });
    f.step(11_000, 99, { receivedAt: 9000, deviceAt: 11_000, sequence: 2 });
    expect(f.state().batteryReceivedAt).toBe(10_000);
    expect(f.state().highSince).toBeNull();
    expect(f.state().lowSince).toBeNull();
    f.step(15_000, 99, { sequence: 3 });
    expect(f.state().highSince).toBe(15_000);
  });
  it("interrupts timers across OFFLINE transitions, including an unseen short transition", () => {
    const f = fixture();
    f.step(0, 20);
    f.step(5000, 20);
    f.step(10_000, 20, {}, false, 2);
    expect(f.state().lowSince).toBeNull();
    f.step(15_000, 20, {}, true, 3);
    expect(f.state().lowSince).toBe(15_000);
    f.step(20_000, 20, {}, true, 5);
    expect(f.state().lowSince).toBe(20_000);
  });
  it("resolves OFFLINE only from monotonic fresh observations across 30 seconds", () => {
    const f = fixture();
    for (let t = 0; t <= 30_000; t += 5000) f.step(t, 80);
    expect(
      f.decisions.filter((d) => d.kind === "OFFLINE" && d.action === "resolve"),
    ).toHaveLength(1);
    const g = fixture();
    g.step(0, 80);
    g.step(30_000, 80, { deviceAt: 0 });
    expect(g.decisions.some((d) => d.action === "resolve")).toBe(false);
  });
  it.each([5000, 5001])(
    "accepts future skew up to 5000ms, not %ims",
    (skew) => {
      const f = fixture();
      f.step(0, 20);
      f.step(5000, 20, { deviceAt: 5000 + skew });
      expect(f.state().lowSince).toBe(skew <= 5000 ? 0 : null);
    },
  );
  it("does not reset valid low evidence when a stale replay arrives, and does not extend it", () => {
    const f = fixture();
    f.step(0, 20);
    f.step(5000, 20);
    f.step(10_000, 99, { deviceAt: -20_000 });
    expect(f.state().lowSince).toBe(0);
    expect(f.state().batteryReceivedAt).toBe(5000);
    f.step(20_001);
    expect(f.state().lowSince).toBeNull();
  });
});
describe("command alert classification", () => {
  it.each(["FAILED", "TIMED_OUT"])(
    "prefers valid late evidence after delivery %s",
    (status) => {
      const c = {
        status,
        executionStatus: "NOT_REPORTED",
        acknowledgementReceivedAt: null,
      };
      expect(commandOutcome(c, 120_000, 119_999)).toBe(
        status === "FAILED" ? "DELIVERY_FAILED" : "UNRESPONSIVE",
      );
      for (const t of [119_999, 120_000, 120_001]) {
        expect(
          commandOutcome({ ...c, executionStatus: "RUNNING" }, 120_000, t),
        ).toBe(t < 120_000 ? null : "UNRESPONSIVE");
        expect(
          commandOutcome(
            { ...c, acknowledgementReceivedAt: new Date(0) },
            120_000,
            t,
          ),
        ).toBe(t < 120_000 ? null : "UNRESPONSIVE");
        expect(
          commandOutcome({ ...c, executionStatus: "SUCCEEDED" }, 120_000, t),
        ).toBe("SUCCEEDED");
        expect(
          commandOutcome({ ...c, executionStatus: "FAILED" }, 120_000, t),
        ).toBe("EXECUTION_FAILED");
        expect(
          commandOutcome({ ...c, executionStatus: "UNCERTAIN" }, 120_000, t),
        ).toBe("UNCERTAIN");
      }
    },
  );
  it("preserves explicit expiry and never treats a receipt as success", () => {
    expect(
      commandOutcome(
        {
          status: "EXPIRED",
          executionStatus: "NOT_REPORTED",
          acknowledgementReceivedAt: null,
        },
        0,
        999,
      ),
    ).toBe("EXPIRED");
    expect(
      commandOutcome(
        {
          status: "ACKNOWLEDGED",
          executionStatus: "NOT_REPORTED",
          acknowledgementReceivedAt: new Date(),
        },
        120_000,
        120_000,
      ),
    ).toBe("UNRESPONSIVE");
  });
});
it("validates thresholds, durations and sampling interval before starting", () => {
  expect(policy.offlineHoldMs).toBe(60_000);
  expect(policy.recoveryHoldMs).toBe(30_000);
  for (const env of [
    { ALERT_EVALUATION_INTERVAL_MS: "0" },
    { ALERT_LOW_BATTERY: "25", ALERT_RECOVERED_BATTERY: "20" },
    { ALERT_OBSERVATION_GAP_MS: "5000" },
    { ALERT_BATTERY_HOLD_MS: "1.5" },
    { TELEMETRY_INTERVAL_MS: "15000" },
    { ALERT_OBSERVATION_GAP_MS: "15001" },
  ])
    expect(() => loadAlertPolicy(env)).toThrow();
});
