const missing = {
  reason: "MISSING",
  stamp: null,
  timeDomain: "SYSTEM",
  clockEpoch: 0,
  receivedAt: null,
};
const valid = {
  ...missing,
  reason: "VALID",
  stamp: { sec: 100, nanosec: 0 },
  receivedAt: "2026-11-06T00:00:00.000Z",
};
export const observation = {
  schemaVersion: 3,
  deviceId: "ros-test",
  sessionId: "a065e32b-c00b-452e-9cb1-3b52c43962fb",
  sequence: 0,
  timestamp: "2026-11-06T00:00:00.000Z",
  payload: {
    source: "ROS2",
    battery: 0,
    temperature: null,
    position: {
      kind: "LOCAL",
      frameId: "fleet/map",
      convention: "ENU",
      unit: "m",
      pose: { x: 1, y: 2, z: -3 },
      velocity: null,
    },
    flightStatus: "UNKNOWN",
    diagnostics: [],
    diagnosticsTruncated: false,
    quality: {
      battery: valid,
      temperature: missing,
      position: valid,
      flightStatus: missing,
      diagnostics: missing,
    },
  },
};
export const fixtures = [
  {
    valid: false,
    message: {
      ...observation,
      payload: { ...observation.payload, temperature: 0 },
    },
  },
  {
    valid: false,
    message: {
      ...observation,
      payload: { ...observation.payload, battery: null },
    },
  },
  {
    valid: false,
    message: {
      ...observation,
      payload: { ...observation.payload, flightStatus: "IDLE" },
    },
  },
  {
    valid: false,
    message: {
      ...observation,
      payload: {
        ...observation.payload,
        diagnostics: [{ name: "component", hardwareId: "device", level: "OK" }],
      },
    },
  },
  {
    valid: false,
    message: {
      ...observation,
      payload: {
        ...observation.payload,
        quality: {
          ...observation.payload.quality,
          battery: { ...valid, stamp: null },
        },
      },
    },
  },
  { valid: true, message: observation },
  { valid: false, message: { ...observation, sessionId: "not-a-session" } },
  { valid: false, message: { ...observation, sequence: -1 } },
  {
    valid: false,
    message: {
      ...observation,
      payload: { ...observation.payload, battery: 101 },
    },
  },
  {
    valid: false,
    message: {
      ...observation,
      payload: {
        ...observation.payload,
        position: { ...observation.payload.position, kind: "GPS" },
      },
    },
  },
  {
    valid: false,
    message: {
      ...observation,
      payload: {
        ...observation.payload,
        quality: {
          ...observation.payload.quality,
          battery: { ...valid, timeDomain: "UTC" },
        },
      },
    },
  },
];
