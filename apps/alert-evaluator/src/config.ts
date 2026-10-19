export const RULE_VERSION = "fleet-alerts-v1";
export interface AlertPolicy {
  intervalMs: number;
  offlineHoldMs: number;
  recoveryHoldMs: number;
  batteryHoldMs: number;
  lowBattery: number;
  recoveredBattery: number;
  gapMs: number;
  freshMs: number;
  futureMs: number;
  commandResultMs: number;
}
export function loadAlertPolicy(
  env: NodeJS.ProcessEnv = process.env,
): AlertPolicy {
  const read = (
    key: string,
    fallback: number,
    min = 1,
    max = 2_147_483_647,
  ) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new TypeError(`${key} has an invalid value`);
    return n;
  };
  const policy = {
    intervalMs: read("ALERT_EVALUATION_INTERVAL_MS", 5000),
    offlineHoldMs: read("ALERT_OFFLINE_HOLD_MS", 60_000),
    recoveryHoldMs: read("ALERT_RECOVERY_HOLD_MS", 30_000),
    batteryHoldMs: read("ALERT_BATTERY_HOLD_MS", 30_000),
    lowBattery: read("ALERT_LOW_BATTERY", 20, 0, 99),
    recoveredBattery: read("ALERT_RECOVERED_BATTERY", 25, 1, 100),
    gapMs: read("ALERT_OBSERVATION_GAP_MS", 15_000, 1, 15_000),
    freshMs: 15_000,
    futureMs: 5000,
    commandResultMs: read("ALERT_COMMAND_RESULT_MS", 120_000),
  };
  if (policy.recoveredBattery <= policy.lowBattery)
    throw new TypeError("recovery battery must exceed low battery");
  if (policy.intervalMs > policy.gapMs)
    throw new TypeError("evaluation interval must not exceed observation gap");
  if (policy.gapMs <= read("TELEMETRY_INTERVAL_MS", 5000))
    throw new TypeError("alert observation gap must exceed telemetry interval");
  return policy;
}
