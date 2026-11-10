/** workspaceが初期化されていることを示す識別子。 */
export const workspaceName = "protocol";

export {
  commandAcknowledgementMessageSchema,
  commandMessageSchema,
  commandV2MessageSchema,
  rosCommandMessageSchema,
  type RosCommandMessage,
  commandAcknowledgementV2MessageSchema,
  commandAcknowledgementV3MessageSchema,
  type CommandAcknowledgementMessage,
  type CommandMessage,
} from "./command.js";

export {
  connectionStatusMessageSchema,
  type ConnectionStatusMessage,
} from "./connection-status.js";

export {
  telemetryMessageSchema,
  telemetryV2MessageSchema,
  type TelemetryMessage,
  type TelemetryV2Message,
  type LegacyTelemetryMessage,
} from "./telemetry.js";

export {
  createCommandAcksTopic,
  createBridgeEventsTopic,
  createBridgeRequestsTopic,
  createBridgeReceiptsTopic,
  createOtaRequestsTopic,
  createOtaEventsTopic,
  createOtaReceiptsTopic,
  createCommandsTopic,
  createStatusTopic,
  createTelemetryTopic,
  createTelemetryReceiptsTopic,
  isValidDeviceId,
  parseMqttTopic,
  type MqttTopicKind,
  type ParsedMqttTopic,
} from "./topics.js";
export * from "./telemetry-receipt.js";
export * from "./ros-observation.js";
export * from "./bridge.js";
export * from "./ota.js";
export * from "./ota-ipc.js";
