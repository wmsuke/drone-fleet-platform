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

export function calculateDroneState(sequence: number): VirtualDroneState {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError("sequence must be a non-negative safe integer");
  }

  const cycleStep = sequence % STATE_CYCLE_STEPS;
  const angle = (cycleStep / STATE_CYCLE_STEPS) * 2 * Math.PI;
  const altitudeStep = Math.min(cycleStep, STATE_CYCLE_STEPS - cycleStep);

  return {
    battery: Math.max(0, 100 - sequence * BATTERY_DECREASE_PER_STEP),
    latitude: BASE_LATITUDE + Math.sin(angle) * POSITION_RADIUS_DEGREES,
    longitude: BASE_LONGITUDE + Math.cos(angle) * POSITION_RADIUS_DEGREES,
    altitude: (altitudeStep / (STATE_CYCLE_STEPS / 2)) * MAX_ALTITUDE_METERS,
    temperature:
      BASE_TEMPERATURE_CELSIUS +
      Math.sin(angle) * TEMPERATURE_AMPLITUDE_CELSIUS,
    status: cycleStep === 0 ? "IDLE" : "FLYING",
  };
}
