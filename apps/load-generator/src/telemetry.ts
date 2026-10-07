import {
  telemetryV2MessageSchema,
  type TelemetryV2Message,
} from "@drone-fleet/protocol";

const STATE_CYCLE_STEPS = 120;

function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function unitValue(value: string): number {
  return hashSeed(value) / 0xffff_ffff;
}

export function createLoadTelemetry(
  deviceId: string,
  sessionId: string,
  sequence: number,
  timestamp: string,
  simulationSeed: string,
): TelemetryV2Message {
  const identity = `${simulationSeed}\u0000${deviceId}`;
  const phase = hashSeed(`${identity}\u0000phase`) % STATE_CYCLE_STEPS;
  const angle =
    (((sequence + phase) % STATE_CYCLE_STEPS) / STATE_CYCLE_STEPS) *
    Math.PI *
    2;

  return telemetryV2MessageSchema.parse({
    schemaVersion: 2,
    deviceId,
    sessionId,
    sequence,
    timestamp,
    payload: {
      battery: Math.max(
        0,
        100 - unitValue(`${identity}\u0000battery`) * 5 - sequence * 0.01,
      ),
      latitude:
        35.681236 +
        (unitValue(`${identity}\u0000latitude`) - 0.5) * 0.02 +
        Math.sin(angle) * 0.001,
      longitude:
        139.767125 +
        (unitValue(`${identity}\u0000longitude`) - 0.5) * 0.02 +
        Math.cos(angle) * 0.001,
      altitude: 25 + Math.sin(angle) * 25,
      temperature:
        25 +
        (unitValue(`${identity}\u0000temperature`) - 0.5) * 4 +
        Math.sin(angle) * 2,
      status: sequence % STATE_CYCLE_STEPS === 0 ? "IDLE" : "FLYING",
    },
  });
}
