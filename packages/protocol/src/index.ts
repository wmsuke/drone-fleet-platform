/** workspaceが初期化されていることを示す識別子。 */
export const workspaceName = "protocol";

export {
  commandAcknowledgementMessageSchema,
  commandMessageSchema,
  commandV2MessageSchema,
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
} from "./telemetry.js";

export {
  createCommandAcksTopic,
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
export * from "./ota.js";
