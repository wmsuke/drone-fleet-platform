import type { TelemetryMessage } from "@drone-fleet/protocol";

const BASE_LATITUDE = 35.681236;
const BASE_LONGITUDE = 139.767125;
const POSITION_RADIUS_DEGREES = 0.001;
const STATE_CYCLE_STEPS = 40;
const MAX_ALTITUDE_METERS = 50;
const BASE_TEMPERATURE_CELSIUS = 25;
const TEMPERATURE_AMPLITUDE_CELSIUS = 5;
const BATTERY_DECREASE_PER_STEP = 0.5;

export type VirtualDroneState = TelemetryMessage["payload"];

function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function unitValue(hash: number): number {
  return hash / 0xffff_ffff;
}

export function calculateDroneState(
  sequence: number,
  simulationSeed = "default",
  deviceId = "drone-001",
): VirtualDroneState {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError("sequence must be a non-negative safe integer");
  }

  const identity = `${simulationSeed}\u0000${deviceId}`;
  const phaseOffset = hashSeed(`${identity}\u0000phase`) % STATE_CYCLE_STEPS;
  const batteryOffset = unitValue(hashSeed(`${identity}\u0000battery`)) * 2;
  const latitudeOffset =
    (unitValue(hashSeed(`${identity}\u0000latitude`)) - 0.5) * 0.002;
  const longitudeOffset =
    (unitValue(hashSeed(`${identity}\u0000longitude`)) - 0.5) * 0.002;
  const temperatureOffset =
    (unitValue(hashSeed(`${identity}\u0000temperature`)) - 0.5) * 2;
  const cycleStep = (sequence + phaseOffset) % STATE_CYCLE_STEPS;
  const angle = (cycleStep / STATE_CYCLE_STEPS) * 2 * Math.PI;
  const altitudeStep = Math.min(cycleStep, STATE_CYCLE_STEPS - cycleStep);

  return {
    battery: Math.max(
      0,
      100 - batteryOffset - sequence * BATTERY_DECREASE_PER_STEP,
    ),
    latitude:
      BASE_LATITUDE +
      latitudeOffset +
      Math.sin(angle) * POSITION_RADIUS_DEGREES,
    longitude:
      BASE_LONGITUDE +
      longitudeOffset +
      Math.cos(angle) * POSITION_RADIUS_DEGREES,
    altitude: (altitudeStep / (STATE_CYCLE_STEPS / 2)) * MAX_ALTITUDE_METERS,
    temperature:
      BASE_TEMPERATURE_CELSIUS +
      temperatureOffset +
      Math.sin(angle) * (TEMPERATURE_AMPLITUDE_CELSIUS - 1),
    status: sequence % STATE_CYCLE_STEPS === 0 ? "IDLE" : "FLYING",
  };
}
