import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { otaParentMessageSchema } from "@drone-fleet/protocol";
import {
  startSimulator,
  type SimulatorMqttClient,
  type RunningSimulator,
} from "./simulator.js";

declare const __OTA_BUILD__: {
  releaseId: string;
  version: string;
  buildId: string;
  behavior: string;
  temperatureOffset: number;
};
const bootId = randomUUID();
const pending = new Map<
  string,
  { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();
const events = new EventEmitter();
let simulator: RunningSimulator | undefined;
const rpc = (method: string, extra: Record<string, unknown> = {}) =>
  new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("IPC timed out"));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    process.send?.({ kind: "rpc", id, method, ...extra });
  });
const client = events as unknown as SimulatorMqttClient;
client.connected = true;
client.options = {};
client.subscribeAsync = async (topic) => rpc("SUBSCRIBE", { topic });
client.publishAsync = async (topic, payload, options) =>
  rpc("PUBLISH", { topic, payload, retain: options.retain });
client.endAsync = async () => {
  await rpc("DISCONNECT");
  client.connected = false;
};
client.reconnect = () => {
  void rpc("RECONNECT").catch(() => events.emit("offline"));
  return client;
};
process.on("message", (input) => {
  const parsed = otaParentMessageSchema.safeParse(input);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.kind === "reply") {
    const wait = pending.get(message.id);
    if (!wait) return;
    clearTimeout(wait.timer);
    pending.delete(message.id);
    if (message.ok) wait.resolve();
    else wait.reject(new Error("IPC operation rejected"));
  } else if (message.kind === "connection") {
    client.connected =
      message.event === "connect"
        ? true
        : message.event === "close" || message.event === "offline"
          ? false
          : client.connected;
    events.emit(message.event);
  } else if (message.kind === "delivery")
    events.emit("message", message.topic, Buffer.from(message.payload), {
      retain: message.retain,
    });
  else
    void (async () => {
      const app = await ready;
      const safe =
        message.purpose === "PREPARE" ? await app.prepareForUpdate() : true;
      if (message.purpose === "RESUME") app.releaseUpdateGate();
      const health = app.inspectHealth();
      if (message.purpose === "STOP") await app.shutdown();
      process.send?.(
        {
          kind: "inspection",
          id: message.id,
          fence: message.fence,
          bootId,
          releaseId: __OTA_BUILD__.releaseId,
          version: __OTA_BUILD__.version,
          buildId: __OTA_BUILD__.buildId,
          behavior: __OTA_BUILD__.behavior,
          ready: safe,
          measuredAt: new Date().toISOString(),
          ...health,
        },
        () => {
          if (message.purpose === "STOP") process.exit(0);
        },
      );
    })().catch(() => {
      /* 応答不能ならsupervisorがtimeoutとして扱う。入力や鍵をログへ出さない */
    });
});
const ready = (async () => {
  await rpc("CONNECT");
  const result = await startSimulator(
    {
      deviceId: process.env.DEVICE_ID!,
      mqttUrl: "ipc://supervisor",
      simulationSeed: process.env.SIMULATION_SEED ?? "default",
      telemetryIntervalMs: Number(process.env.TELEMETRY_INTERVAL_MS ?? "5000"),
      telemetryBufferPath: `${process.env.APP_DATA_DIR}/telemetry.sqlite`,
      telemetryBufferMaxRows: 10000,
      telemetryBufferMaxBytes: 33554432,
      telemetryTemperatureOffset: __OTA_BUILD__.temperatureOffset,
    },
    async () => client,
  );
  simulator = result;
  return result;
})();
process.once("disconnect", () => {
  void simulator?.shutdown().finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 1000).unref();
});
void ready.catch(() => process.exit(1));
