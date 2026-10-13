import { connect } from "mqtt";
import { randomUUID } from "node:crypto";
import type { ApiMqttConnectionConfig } from "./mqtt-transport.js";

// 再接続キューを持たせず、試行終了時に接続を破棄する。期限後の遅延送信を防ぐ。
export function createOutboxPublisher(
  connection: ApiMqttConnectionConfig,
  timeoutMs = 5000,
) {
  return async (
    topic: string,
    payload: string,
    expiresAt: Date,
  ): Promise<void> => {
    const remaining = Math.min(timeoutMs, expiresAt.getTime() - Date.now());
    if (remaining <= 0) throw new Error("command expired");
    const client = connect(connection.url, {
      ...connection.clientOptions,
      ...(connection.clientOptions.clientId === "fleet-api" &&
      connection.url.startsWith("mqtt://")
        ? { clientId: `fleet-api-${randomUUID()}` }
        : {}),
      reconnectPeriod: 0,
      connectTimeout: remaining,
      queueQoSZero: false,
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end(true, {}, () =>
          error ? reject(new Error("command publish failed")) : resolve(),
        );
      };
      const timer = setTimeout(
        () => finish(new Error("publish timeout")),
        remaining,
      );
      client.on("error", finish);
      client.on("close", () => finish(new Error("connection closed")));
      client.once("connect", () => {
        if (settled || Date.now() >= expiresAt.getTime()) {
          finish(new Error("command expired"));
          return;
        }
        client.publish(topic, payload, { qos: 1, retain: false }, (error) =>
          finish(error ?? undefined),
        );
      });
    });
  };
}
