import { connect, type MqttClient } from "mqtt";
import { writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  commandV2MessageSchema,
  commandAcknowledgementV3MessageSchema,
  createCommandsTopic,
  createCommandAcksTopic,
} from "@drone-fleet/protocol";

export type ResponseCondition = "success" | "failure" | "unresponsive";
export function responseFor(index: number, condition: ResponseCondition) {
  if (index % 10 !== 0 || condition === "success") return "SUCCEEDED";
  return condition === "failure" ? "FAILED" : null;
}

async function main() {
  // ローカル専用。AWSの認証・料金制御を迂回する経路を作らない。
  const host = process.env.MQTT_HOST;
  if (host !== "mqtt") throw new Error("dedicated local Compose only");
  const count = Number(process.env.FLEET_LOAD_DEVICES ?? 100);
  if (![10, 100, 1000].includes(count)) throw new Error("invalid device count");
  const prefix = process.env.FLEET_LOAD_PREFIX ?? "fleetload";
  if (!/^[a-z0-9-]{1,32}$/.test(prefix)) throw new Error("invalid prefix");
  const clients: MqttClient[] = [];
  const seen = new Set<string>();
  const events: unknown[] = [];
  const pending = new Set<Promise<void>>();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let failures = 0;
  const start = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  for (let index = 1; index <= count; index++) {
    const deviceId = `${prefix}-${String(index).padStart(4, "0")}`;
    const client = connect("mqtt://mqtt:1883", {
      clientId: deviceId,
      reconnectPeriod: 0,
      connectTimeout: 10000,
    });
    clients.push(client);
    client.on("error", () => {
      failures++;
    });
    client.on("message", (_topic, body) => {
      const work = (async () => {
        const command = commandV2MessageSchema.parse(
          JSON.parse(body.toString()),
        );
        if (command.deviceId !== deviceId) throw new Error("device mismatch");
        if (seen.has(command.commandId)) return;
        seen.add(command.commandId);
        // 応答条件は試行中に変えない。未応答でも購読自体は続ける。
        const condition = process.env.FLEET_LOAD_CONDITION as ResponseCondition;
        if (!["success", "failure", "unresponsive"].includes(condition))
          throw new Error("invalid condition");
        const result = responseFor(index, condition);
        const receivedAt = new Date().toISOString();
        events.push({
          commandId: command.commandId,
          deviceId,
          receivedAt,
          result,
        });
        if (!result) {
          return;
        }
        const startedAt = new Date().toISOString();
        const send = async (
          status: "ACKNOWLEDGED" | "RUNNING" | "SUCCEEDED" | "FAILED",
        ) => {
          const message = commandAcknowledgementV3MessageSchema.parse({
            schemaVersion: 3,
            commandId: command.commandId,
            deviceId,
            timestamp: new Date().toISOString(),
            status,
            ...(status === "ACKNOWLEDGED" ? {} : { startedAt }),
          });
          const publishedAt = new Date().toISOString();
          await client.publishAsync(
            createCommandAcksTopic(deviceId),
            JSON.stringify(message),
            { qos: 1, retain: false },
          );
          events.push({
            commandId: command.commandId,
            deviceId,
            status,
            publishedAt,
            pubackAt: new Date().toISOString(),
          });
        };
        await send("ACKNOWLEDGED");
        await send("RUNNING");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await send(result);
      })().catch(() => {
        failures++;
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
    });
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject);
      client.once("connect", () => {
        client.subscribe(createCommandsTopic(deviceId), { qos: 1 }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    });
  }
  await writeFile(
    "/workspace/load-results/ready.json",
    JSON.stringify({ count, readyAt: new Date().toISOString() }),
  );
  const stop = async () => {
    await Promise.all(pending);
    delay.disable();
    await writeFile(
      "/workspace/load-results/responder.json",
      JSON.stringify({
        schemaVersion: 1,
        count,
        events,
        failures,
        cpuMicros: process.cpuUsage(cpuStart),
        elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
        memoryBytes: process.memoryUsage(),
        eventLoopDelayMs: {
          p95: delay.percentile(95) / 1e6,
          max: delay.max / 1e6,
        },
      }),
    );
    await Promise.all(clients.map((c) => c.endAsync(true)));
  };
  process.once("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });
  setTimeout(() => {
    void stop().then(() => process.exit(1));
  }, 180000).unref();
}
if (process.argv[1]?.endsWith("fleet-responder.js")) {
  main().catch(() => {
    console.error("command負荷応答器に失敗しました");
    process.exitCode = 1;
  });
}
