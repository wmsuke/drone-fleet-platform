// OTA childのbundleではMQTT transportを含めない。接続は必ずIPC経由。
export async function connectAsync(): Promise<never> {
  throw new Error("child MQTT transport is disabled");
}
