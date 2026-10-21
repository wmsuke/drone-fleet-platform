import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { otaParentMessageSchema } from "@drone-fleet/protocol";
import { join } from "node:path";
import {
  otaChildMessageSchema,
  createCommandsTopic,
  createTelemetryReceiptsTopic,
  createTelemetryTopic,
  createCommandAcksTopic,
  createStatusTopic,
  type OtaChildMessage,
} from "@drone-fleet/protocol";
import type { Envelope } from "@drone-fleet/releases";
import type { SimulatorMqttClient } from "@drone-fleet/simulator";
import { verifyInstalled } from "./artifacts.js";
import { Journal, OtaError } from "./journal.js";

export type Inspection = Extract<OtaChildMessage, { kind: "inspection" }> & {
  digest: string;
  roundTripMs: number;
  requestedMonotonicMs: number;
};
export class ChildHost {
  private child?: ChildProcess;
  private waits = new Map<
    string,
    {
      resolve: (v: Inspection) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      fence: string;
      startedMs: number;
    }
  >();
  private expectedStop = false;
  private envelope?: Envelope;
  private bootId?: string;
  gate = true;
  suppressDisconnect = false;
  readonly subscriptions = new Set<string>();
  constructor(
    private root: string,
    private data: string,
    private deviceId: string,
    private client: SimulatorMqttClient,
    private journal: Journal,
    private interval: number,
  ) {}
  async start(envelope: Envelope) {
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== 0 ||
      !process.versions.node.startsWith("22.")
    )
      throw new OtaError("INCOMPATIBLE_RELEASE");
    if (this.child) throw new OtaError("DEVICE_BUSY");
    const directory = await verifyInstalled(this.root, envelope);
    this.envelope = envelope;
    this.expectedStop = false;
    this.bootId = undefined;
    this.journal.change({ launching: true });
    const child = fork(join(directory, "app/main.mjs"), [], {
      cwd: directory,
      execPath: process.execPath,
      execArgv: [],
      uid: 10001,
      gid: 10001,
      env: {
        NODE_ENV: "production",
        DEVICE_ID: this.deviceId,
        APP_DATA_DIR: this.data,
        TELEMETRY_INTERVAL_MS: String(this.interval),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    this.journal.change({ childPid: child.pid ?? null, launching: false });
    child.on("message", (input) => {
      const result = otaChildMessageSchema.safeParse(input);
      if (!result.success) return;
      const message = result.data;
      if (message.kind === "rpc") {
        void this.rpc(message).then(
          () => this.send({ kind: "reply", id: message.id, ok: true }),
          () => this.send({ kind: "reply", id: message.id, ok: false }),
        );
      } else {
        const wait = this.waits.get(message.id);
        if (!wait || wait.fence !== message.fence) return;
        const m = this.envelope!.manifest;
        if (
          message.releaseId !== m.releaseId ||
          message.version !== m.version ||
          message.buildId !== m.buildId ||
          (this.bootId && this.bootId !== message.bootId)
        ) {
          wait.reject(new OtaError("DIGEST_MISMATCH"));
        } else {
          this.bootId = message.bootId;
          wait.resolve({
            ...message,
            digest: m.digest,
            roundTripMs: performance.now() - wait.startedMs,
            requestedMonotonicMs: wait.startedMs,
          });
        }
        clearTimeout(wait.timer);
        this.waits.delete(message.id);
      }
    });
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const wait of this.waits.values()) {
        clearTimeout(wait.timer);
        wait.reject(new OtaError("RESULT_UNKNOWN"));
      }
      this.waits.clear();
      if (!this.expectedStop) {
        this.gate = true;
        this.journal.change({ phase: "UNCERTAIN", fault: "RESULT_UNKNOWN" });
      }
    });
    child.once("error", () => {
      this.gate = true;
      this.journal.change({ phase: "UNCERTAIN", fault: "BOOT_FAILED" });
    });
    return this.inspect("HEALTH", this.journal.read().highestFence, 30000);
  }
  private async rpc(message: Extract<OtaChildMessage, { kind: "rpc" }>) {
    const device = this.deviceId;
    if (message.method === "CONNECT") {
      if (!this.client.connected) throw new Error("offline");
      return;
    }
    if (message.method === "SUBSCRIBE") {
      if (
        ![
          createCommandsTopic(device),
          createTelemetryReceiptsTopic(device),
        ].includes(message.topic ?? "")
      )
        throw new Error("topic denied");
      const grants = await this.client.subscribeAsync(message.topic!, {
        qos: 1,
      });
      if (
        Array.isArray(grants) &&
        grants.some((g: { qos: number }) => g.qos !== 1)
      )
        throw new Error("subscription denied");
      this.subscriptions.add(message.topic!);
      return;
    }
    if (message.method === "PUBLISH") {
      const topic = message.topic ?? "";
      if (
        ![
          createTelemetryTopic(device),
          createCommandAcksTopic(device),
          createStatusTopic(device),
        ].includes(topic) ||
        message.retain !== (topic === createStatusTopic(device))
      )
        throw new Error("topic denied");
      if (this.suppressDisconnect && topic === createStatusTopic(device))
        return;
      await this.client.publishAsync(topic, message.payload!, {
        qos: 1,
        retain: !!message.retain,
      });
      return;
    }
    if (this.suppressDisconnect) return;
    if (message.method === "DISCONNECT") await this.client.endAsync(true);
    if (message.method === "RECONNECT") this.client.reconnect();
  }
  private send(value: unknown) {
    try {
      if (this.child?.connected)
        this.child.send(otaParentMessageSchema.parse(value));
    } catch {
      /* timeoutで検出 */
    }
  }
  deliver(topic: string, payload: Buffer, retain: boolean) {
    if (topic === createCommandsTopic(this.deviceId) && this.gate) return;
    this.send({
      kind: "delivery",
      topic,
      payload: payload.toString("utf8"),
      retain,
    });
  }
  connection(event: "connect" | "close" | "offline" | "reconnect") {
    if (event === "close" || event === "offline") this.subscriptions.clear();
    this.send({ kind: "connection", event });
  }
  inspect(
    purpose: "PREPARE" | "HEALTH" | "RESUME" | "STOP",
    fence: string,
    timeout = 5000,
  ): Promise<Inspection> {
    if (!this.child?.connected)
      return Promise.reject(new OtaError("RESULT_UNKNOWN"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits.delete(id);
        reject(new OtaError("RESULT_UNKNOWN"));
      }, timeout);
      this.waits.set(id, {
        resolve,
        reject,
        timer,
        fence,
        startedMs: performance.now(),
      });
      this.send({ kind: "inspect", id, fence, purpose });
    });
  }
  async stop(fence: string) {
    const child = this.child;
    if (!child) throw new OtaError("RESULT_UNKNOWN");
    this.expectedStop = true;
    this.suppressDisconnect = true;
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new OtaError("RESULT_UNKNOWN")),
        10000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    void exited.catch(() => {});
    try {
      await this.inspect("STOP", fence);
      await exited;
      this.journal.change({ childPid: null, launching: false });
    } finally {
      this.suppressDisconnect = false;
    }
  }
}
