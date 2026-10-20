import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openMqttFixture } from "./fleet-mqtt-fixture.js";
import {
  commandV2MessageSchema,
  commandAcknowledgementMessageSchema,
  telemetryV2MessageSchema,
  connectionStatusMessageSchema,
  createTelemetryTopic,
  createStatusTopic,
  createCommandAcksTopic,
  type CommandMessage,
} from "@drone-fleet/protocol";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
// 実行入口はrepository rootのpnpm test:fleet-e2eに固定する。
const root = resolve(process.cwd());
export async function eventually<T>(
  name: string,
  read: () => Promise<T | false>,
  timeout = 20000,
): Promise<T> {
  const until = Date.now() + timeout;
  let last: unknown;
  do {
    try {
      const v = await read();
      if (v !== false) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < until);
  throw new Error(`${name}: ${String(last ?? "条件不成立")}`);
}
export class FleetE2eHarness {
  readonly project =
    process.env.FLEET_E2E_PROJECT ?? `fleet-e2e-${randomUUID()}`;
  readonly directory = resolve(root, "fleet-e2e-results", this.project);
  readonly report: Record<string, unknown> = {
    schemaVersion: 1,
    status: "running",
    transport: "local",
    startedAt: new Date().toISOString(),
    aws: {
      executed: false,
      unverified: ["mTLS", "IoT Policy", "AWS経路・費用"],
    },
    scenarios: {},
  };
  readonly commands = new Map<string, CommandMessage>();
  base = "";
  private client?: Awaited<ReturnType<typeof openMqttFixture>>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatWork = new Set<Promise<void>>();
  private transcript = "";
  private failures: string[] = [];
  private deadline = Date.now() + 540000;
  phase(name: string) {
    this.report.phase = name;
    process.stdout.write(`Fleet E2E: ${name}\n`);
  }
  async compose(args: string[], timeout = 30000) {
    if (!/^fleet-e2e-[a-z0-9-]{1,64}$/.test(this.project))
      throw new Error("専用project名が必要");
    const command = [
      "compose",
      "--env-file",
      "/dev/null",
      "-f",
      resolve(root, "compose.fleet-e2e.yaml"),
      "-p",
      this.project,
      ...args,
    ];
    try {
      const { stdout, stderr } = await exec("docker", command, {
        cwd: root,
        timeout: Math.max(1, Math.min(timeout, this.deadline - Date.now())),
        maxBuffer: 16 * 1024 * 1024,
      });
      this.transcript += `\n${args.join(" ")}\n${stdout}\n${stderr}`;
      return stdout.trim();
    } catch (e) {
      const error = e as Error & { stdout?: string; stderr?: string };
      this.transcript += `\n${args.join(" ")}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`;
      throw e;
    }
  }
  async port(service: string, port: number) {
    const p = await this.compose(["port", service, String(port)]);
    const m = /:(\d+)$/.exec(p);
    if (!m) throw new Error("portなし");
    return Number(m[1]);
  }
  async request(path: string, method = "GET", body?: unknown, key?: string) {
    const r = await fetch(this.base + path, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.transcript += `\nHTTP ${method} ${path}: ${r.status}`;
    if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
    return r;
  }
  async pg<T>(query: string, params: string[] = []): Promise<T> {
    return JSON.parse(
      await this.compose([
        "exec",
        "-T",
        "probe",
        "node",
        "--input-type=module",
        "-e",
        `import {createDatabase} from './packages/database/dist/index.js';const {client}=createDatabase();try{console.log(JSON.stringify(await client.unsafe(${JSON.stringify(query)},${JSON.stringify(params)})));}finally{await client.end();}`,
      ]),
    );
  }
  async start() {
    await mkdir(this.directory, { recursive: true });
    this.phase("専用環境起動");
    await this.compose(["build", "probe"], 240000);
    await this.compose(
      [
        "up",
        "--no-build",
        "-d",
        "--wait",
        "postgres",
        "mqtt",
        "migrate",
        "telemetry-ingestor",
        "api",
        "simulator",
        "alert-evaluator",
        "probe",
      ],
      240000,
    );
    this.base = `http://127.0.0.1:${await this.port("api", 3000)}`;
    await eventually("API", async () => (await this.request("/devices")).ok);
    this.client = await openMqttFixture(
      `mqtt://127.0.0.1:${await this.port("mqtt", 1883)}`,
      `${this.project}-fixture`,
      (_topic, body) => {
        try {
          const command = commandV2MessageSchema.parse(
            JSON.parse(body.toString()),
          );
          this.commands.set(command.deviceId, command);
        } catch {
          this.failures.push("invalid command");
        }
      },
      () => this.failures.push("MQTT fixture error"),
    );
    const sessions = new Map(
      ["fleet-failed", "fleet-expired", "fleet-silent", "fleet-spare"].map(
        (id) => [id, randomUUID()],
      ),
    );
    let sequence = 0;
    const lastSequences = new Map<string, number>();
    const sendTelemetry = async (id: string) => {
      const message = telemetryV2MessageSchema.parse({
        schemaVersion: 2,
        deviceId: id,
        sessionId: sessions.get(id),
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        payload: {
          battery: 90,
          latitude: 35,
          longitude: 139,
          altitude: 0,
          temperature: 25,
          status: "IDLE",
        },
      });
      lastSequences.set(id, message.sequence);
      await this.client!.publishAsync(
        createTelemetryTopic(id),
        JSON.stringify(message),
        { qos: 1, retain: false },
      );
    };
    for (const id of sessions.keys()) await sendTelemetry(id);
    await eventually("機体登録", async () => {
      const d = (await (await this.request("/devices")).json()) as {
        deviceId: string;
      }[];
      // PUBACKだけではingestorの購読・保存完了を示さない。未登録機体だけ再送する。
      const registered = new Set(d.map((device) => device.deviceId));
      for (const id of sessions.keys())
        if (!registered.has(id)) await sendTelemetry(id);
      return d.length === 5;
    });
    // 再送分のflushより前にOFFLINE通知を送ると、後のtelemetryでONLINEへ戻り得る。
    await eventually("fixture telemetryの全保存", async () => {
      const saved = await this.pg<{ device_id: string; sequence: string }[]>(
        "SELECT device_id,max(sequence) AS sequence FROM telemetry WHERE device_id LIKE 'fleet-%' GROUP BY device_id",
      );
      return [...lastSequences].every(([id, seq]) =>
        saved.some(
          (row) => row.device_id === id && Number(row.sequence) >= seq,
        ),
      );
    });
    const offline = connectionStatusMessageSchema.parse({
      schemaVersion: 1,
      deviceId: "fleet-expired",
      timestamp: new Date().toISOString(),
      payload: { status: "OFFLINE", reason: "SHUTDOWN" },
    });
    await this.client.publishAsync(
      createStatusTopic("fleet-expired"),
      JSON.stringify(offline),
      { qos: 1, retain: false },
    );
    this.heartbeat = setInterval(() => {
      const work = Promise.all(
        ["fleet-failed", "fleet-silent", "fleet-spare"].map(sendTelemetry),
      )
        .then(() => undefined)
        .catch(() => {
          this.failures.push("heartbeat error");
        });
      this.heartbeatWork.add(work);
      void work.finally(() => this.heartbeatWork.delete(work));
    }, 1000);
    await eventually("ONLINE/OFFLINE混在", async () => {
      const d = (await (await this.request("/devices")).json()) as {
        deviceId: string;
        connectionStatus: string;
      }[];
      return (
        d.find((x) => x.deviceId === "fleet-expired")?.connectionStatus ===
          "OFFLINE" &&
        d.filter((x) => x.connectionStatus === "ONLINE").length === 4
      );
    });
  }
  async ack(
    id: string,
    status:
      | "ACKNOWLEDGED"
      | "RUNNING"
      | "SUCCEEDED"
      | "FAILED"
      | "REJECTED_EXPIRED",
    startedAt?: string,
  ) {
    const c = this.commands.get(id);
    if (!c) throw new Error(`command未受信: ${id}`);
    const m = commandAcknowledgementMessageSchema.parse({
      schemaVersion: status === "REJECTED_EXPIRED" ? 2 : 3,
      deviceId: id,
      commandId: c.commandId,
      status,
      timestamp: new Date().toISOString(),
      ...(startedAt ? { startedAt } : {}),
    });
    await this.client!.publishAsync(
      createCommandAcksTopic(id),
      JSON.stringify(m),
      { qos: 1, retain: false },
    );
  }
  async cleanup() {
    this.deadline = Date.now() + 90000;
    if (this.heartbeat) clearInterval(this.heartbeat);
    await Promise.all(this.heartbeatWork);
    const errors: string[] = [];
    try {
      await this.client?.endAsync(true);
    } catch {
      errors.push("MQTT終了失敗");
    }
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(
        resolve(this.directory, "services.log"),
        await this.compose(["logs", "--no-color", "--timestamps"], 15000),
      );
    } catch {
      errors.push("ログ取得失敗");
    }
    try {
      await this.compose(
        ["down", "--volumes", "--remove-orphans", "--timeout", "5"],
        60000,
      );
    } catch {
      errors.push("Compose削除失敗");
    }
    try {
      const image = `${this.project}-runtime`;
      const { stdout } = await exec("docker", ["image", "ls", "-q", image], {
        timeout: 10000,
      });
      if (stdout.trim())
        await exec("docker", ["image", "rm", image], { timeout: 15000 });
    } catch {
      errors.push("専用image削除失敗");
    }
    for (const args of [
      ["ps", "-aq"],
      ["volume", "ls", "-q"],
      ["network", "ls", "-q"],
    ]) {
      try {
        const { stdout } = await exec(
          "docker",
          [
            ...args,
            "--filter",
            `label=com.docker.compose.project=${this.project}`,
          ],
          { timeout: 10000 },
        );
        if (stdout.trim()) errors.push("専用資源が残存");
      } catch {
        errors.push("残存確認失敗");
      }
    }
    this.report.cleanup = { success: errors.length === 0, errors };
    this.report.fixtureErrors = this.failures;
    this.report.finishedAt = new Date().toISOString();
    if (errors.length || this.failures.length) this.report.status = "failed";
    await mkdir(this.directory, { recursive: true });
    await writeFile(resolve(this.directory, "commands.log"), this.transcript);
    await writeFile(
      resolve(this.directory, "result.json"),
      JSON.stringify(this.report, null, 2) + "\n",
    );
    if (errors.length || this.failures.length)
      throw new Error([...errors, ...this.failures].join("; "));
  }
}
