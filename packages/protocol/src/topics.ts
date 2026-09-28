const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOPIC_PREFIX = ["fleet", "v1", "devices"] as const;

export type MqttTopicKind =
  | "telemetry"
  | "status"
  | "commands"
  | "command-acks";

export interface ParsedMqttTopic {
  kind: MqttTopicKind;
  deviceId: string;
}

export function isValidDeviceId(deviceId: string): boolean {
  return DEVICE_ID_PATTERN.test(deviceId);
}

function assertValidDeviceId(deviceId: string): void {
  if (!isValidDeviceId(deviceId)) {
    throw new TypeError(
      "deviceId must be 1-64 characters using only letters, numbers, hyphens, and underscores",
    );
  }
}

function createMqttTopic(deviceId: string, kind: MqttTopicKind): string {
  assertValidDeviceId(deviceId);
  return `${TOPIC_PREFIX.join("/")}/${deviceId}/${kind}`;
}

export function createTelemetryTopic(deviceId: string): string {
  return createMqttTopic(deviceId, "telemetry");
}

export function createStatusTopic(deviceId: string): string {
  return createMqttTopic(deviceId, "status");
}

export function createCommandsTopic(deviceId: string): string {
  return createMqttTopic(deviceId, "commands");
}

export function createCommandAcksTopic(deviceId: string): string {
  return createMqttTopic(deviceId, "command-acks");
}

function isMqttTopicKind(value: string): value is MqttTopicKind {
  return (
    value === "telemetry" ||
    value === "status" ||
    value === "commands" ||
    value === "command-acks"
  );
}

export function parseMqttTopic(topic: string): ParsedMqttTopic | null {
  const segments = topic.split("/");

  if (
    segments.length !== 5 ||
    segments[0] !== TOPIC_PREFIX[0] ||
    segments[1] !== TOPIC_PREFIX[1] ||
    segments[2] !== TOPIC_PREFIX[2]
  ) {
    return null;
  }

  const deviceId = segments[3];
  const kind = segments[4];

  if (
    deviceId === undefined ||
    kind === undefined ||
    !isValidDeviceId(deviceId) ||
    !isMqttTopicKind(kind)
  ) {
    return null;
  }

  return { kind, deviceId };
}
