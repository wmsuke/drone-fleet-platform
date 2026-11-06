export function configuration(digest, deviceId = "bridge-fixture") {
  const limits = {
    minBatteryPercent: 20,
    maxDistanceMm: 10000,
    sensorFreshnessMs: 3000,
    heartbeatTimeoutMs: 3000,
    positionToleranceMm: 200,
    stoppedSpeedMmPerSecond: 50,
    dwellMs: 1000,
  };
  const definition = {
    profileId: "reference-return-home",
    version: "1.1.0",
    model: "reference_vehicle",
    operations: [
      {
        command: "RETURN_HOME",
        actionType: "fleet_bridge_interfaces/action/ReturnHome",
        actionName: "return_home",
      },
    ],
    frames: {
      position: "map",
      velocity: "base_link",
      convention: "ENU",
      positionUnit: "m",
      velocityUnit: "m/s",
      angularUnit: "rad/s",
    },
    requiredSensors: ["battery", "odometry", "runtime_state"],
    homeDefinition: "SERVER_BOOT_REGISTERED_POSE",
    resultCacheMs: 900000,
    limits,
  };
  const known = (id) => ({
    status: "KNOWN",
    id,
    version: "0.3.0",
    releaseDigest: "a".repeat(64),
  });
  const policy = (id) => ({
    status: "KNOWN",
    id,
    version: "1.0.0",
    digest: digest(limits),
    definition: limits,
  });
  return {
    deviceId,
    namespace:
      "/fleet/d_" +
      Array.from(deviceId)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    serverInstanceId: "11111111-1111-4111-8111-111111111111",
    homeId: "home-fixture",
    adapterConfigurationId: "b".repeat(64),
    profile: { definition, digest: digest(definition) },
    bridge: known("fleet_bridge"),
    adapter: known("fleet_reference"),
    runtime: {
      status: "KNOWN",
      manifestDigest: "c".repeat(64),
      rosDistro: "jazzy",
      rmw: "rmw_fastrtps_cpp",
      python: "3.12.3",
      architecture: "amd64",
    },
    operatingPolicy: policy("reference-operation"),
    safetyConfig: policy("reference-safety"),
    ai: { status: "NOT_APPLICABLE", reason: "NOT_USED" },
  };
}
export function report(digest, deviceId = "bridge-fixture") {
  const value = configuration(digest, deviceId);
  return {
    schemaVersion: 1,
    deviceId,
    kind: "CONFIGURATION",
    eventId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    journalId: "44444444-4444-4444-8444-444444444444",
    sequence: 1,
    reportSequence: 1,
    configurationRevision: 1,
    configurationId: digest(value),
    configuration: value,
    timestamp: "2026-11-06T03:00:00.000Z",
  };
}
export function fixtures(digest) {
  const message = report(digest);
  return [
    { valid: true, message },
    {
      valid: true,
      message: {
        ...message,
        configuration: {
          ...message.configuration,
          bridge: { status: "UNKNOWN", reason: "VERSION_UNREPORTED" },
        },
      },
    },
    {
      valid: false,
      message: {
        ...message,
        configuration: {
          ...message.configuration,
          bridge: { ...message.configuration.bridge, version: "99.0.0" },
        },
      },
    },
    {
      valid: false,
      message: {
        ...message,
        configuration: {
          ...message.configuration,
          ai: { status: "KNOWN", version: "fake-model" },
        },
      },
    },
    {
      valid: false,
      message: {
        ...message,
        configuration: {
          ...message.configuration,
          profile: {
            ...message.configuration.profile,
            definition: {
              ...message.configuration.profile.definition,
              operations: [
                {
                  command: "REBOOT",
                  actionType: "node-restart",
                  actionName: "restart",
                },
              ],
            },
          },
        },
      },
    },
  ];
}
