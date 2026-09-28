/** workspaceが初期化されていることを示す識別子。 */
export const workspaceName = "protocol";

export {
  connectionStatusMessageSchema,
  type ConnectionStatusMessage,
} from "./connection-status.js";

export { telemetryMessageSchema, type TelemetryMessage } from "./telemetry.js";

export {
  createCommandAcksTopic,
  createCommandsTopic,
  createStatusTopic,
  createTelemetryTopic,
  isValidDeviceId,
  parseMqttTopic,
  type MqttTopicKind,
  type ParsedMqttTopic,
} from "./topics.js";
