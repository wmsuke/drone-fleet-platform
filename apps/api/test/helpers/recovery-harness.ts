import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { connectAsync, type MqttClient } from "mqtt";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
export interface Identity {
  session_id: string;
  sequence: number;
}
export const key = (row: Identity) => `${row.session_id}/${row.sequence}`;
export function reconcile(
  expected: string[],
  saved: string[],
  discarded: string[] = [],
) {
  const stored = new Set(saved);
  const dropped = new Set(discarded);
  return {
    missing: expected.filter((id) => !stored.has(id) && !dropped.has(id)),
    lost: expected.filter((id) => !stored.has(id) && dropped.has(id)),
    duplicates: saved.filter((id, index) => saved.indexOf(id) !== index),
  };
}
export async function poll<T>(
  description: string,
  check: () => Promise<T | false>,
  timeout = 20000,
): Promise<T> {
  const until = Date.now() + timeout;
  let lastError: unknown;
  do {
    try {
      const result = await check();
      if (result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  } while (Date.now() < until);
  throw new Error(
    `${description}: ${String(lastError ?? "条件が成立しなかった")}`,
  );
}

export class RecoveryHarness {
  readonly project =
    process.env.RECOVERY_PROJECT ?? `recovery-${randomUUID().slice(0, 12)}`;
  readonly directory = resolve(
    process.env.RECOVERY_RESULTS_DIR ?? resolve(root, "recovery-results"),
    this.project,
  );
  readonly report: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    transport: "local",
    aws: {
      executed: false,
      unverified: [
        "AWS IoT Core mTLSでの復旧",
        "IoT Policy",
        "実AWS経路の費用・メッセージ数",
      ],
    },
    scenarios: {},
    status: "running",
  };
  private transcript = "";
  private clients: MqttClient[] = [];
  private deadline = Date.now() + 300000;
  private cleaning = false;
  phase(name: string) {
    this.report.phase = name;
    console.log(`復旧E2E: ${name}`);
  }
  async compose(args: string[], timeout = 30000): Promise<string> {
    if (!/^recovery-[a-z0-9-]{1,64}$/.test(this.project))
      throw new Error("復旧E2E専用のproject名が必要");
    if (!this.cleaning) {
      timeout = Math.min(timeout, this.deadline - Date.now());
      if (timeout <= 0) throw new Error("復旧E2Eの実行時間上限に達した");
    }
    const command = [
      "compose",
      "--env-file",
      "/dev/null",
      "-f",
      resolve(root, "compose.recovery.yaml"),
      "-p",
      this.project,
      "--profile",
      "limited",
      ...args,
    ];
    try {
      const { stdout, stderr } = await exec("docker", command, {
        cwd: root,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      });
      this.transcript += `\n${args.join(" ")}\n${stdout}\n${stderr}`;
      return stdout.trim();
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      this.transcript += `\n${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      throw error;
    }
  }
  async start() {
    await mkdir(this.directory, { recursive: true });
    await this.compose(
      [
        "up",
        "--build",
        "-d",
        "--wait",
        "postgres",
        "mqtt",
        "migrate",
        "telemetry-ingestor",
        "simulator",
        "api",
        "probe",
      ],
      180000,
    );
    await poll("API起動", async () => (await this.http("/devices")).ok);
  }
  async port(service: string, port: number) {
    const output = await this.compose(["port", service, String(port)]);
    const match = /:(\d+)$/.exec(output);
    if (!match) throw new Error(`portを取得できない: ${service}`);
    return Number(match[1]);
  }
  async http(path: string, body?: unknown) {
    const port = await this.port("api", 3000);
    return fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(5000),
      ...(body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
  }
  async probe<T>(code: string): Promise<T> {
    return JSON.parse(
      await this.compose([
        "exec",
        "-T",
        "probe",
        "node",
        "--input-type=module",
        "-e",
        code,
      ]),
    );
  }
  async pg<T>(query: string, params: string[] = []): Promise<T> {
    return this
      .probe<T>(`import { createDatabase } from './packages/database/dist/index.js';
      const { client } = createDatabase();
      try { console.log(JSON.stringify(await client.unsafe(${JSON.stringify(query)}, ${JSON.stringify(params)}))); }
      finally { await client.end(); }`);
  }
  async sqlite<T>(query: string, device = "drone-001"): Promise<T> {
    if (!/^(drone|limited)-001$/.test(device))
      throw new Error("unknown test device");
    return this.probe<T>(`import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync('/workspace/simulator-data/${device}.sqlite', { readOnly: true });
      try { db.exec('PRAGMA busy_timeout=5000'); console.log(JSON.stringify(db.prepare(${JSON.stringify(query)}).all())); }
      finally { db.close(); }`);
  }
  async kill(service: "simulator" | "api" | "limited-simulator") {
    await this.compose(["kill", "--signal", "SIGKILL", service]);
    await poll(`${service}強制停止`, async () => {
      const running = await this.compose([
        "ps",
        "--status",
        "running",
        "--services",
        service,
      ]);
      return running === "";
    });
  }
  async observe() {
    const port = await this.port("mqtt", 1883);
    const client = await connectAsync(
      `mqtt://127.0.0.1:${port}`,
      {
        clean: true,
        reconnectPeriod: 100,
        connectTimeout: 5000,
        clientId: `probe-${this.project}`,
      },
      false,
    );
    this.clients.push(client);
    client.on("error", () => undefined);
    const messages: { topic: string; payload: string }[] = [];
    client.on("message", (topic, payload) =>
      messages.push({ topic, payload: payload.toString() }),
    );
    await client.subscribeAsync(
      ["telemetry", "telemetry-receipts", "commands", "command-acks"].map(
        (kind) => `fleet/v1/devices/+/${kind}`,
      ),
      { qos: 1 },
    );
    return { client, messages };
  }
  async cleanup() {
    this.cleaning = true;
    const errors: string[] = [];
    await Promise.all(
      this.clients
        .filter((client) => !client.disconnected)
        .map((client) =>
          client
            .endAsync(true)
            .catch(() => errors.push("MQTT観測接続の終了に失敗")),
        ),
    );
    try {
      const logs = await this.compose(
        ["logs", "--no-color", "--timestamps"],
        15000,
      );
      await writeFile(resolve(this.directory, "services.log"), logs);
    } catch {
      errors.push("サービスログの取得に失敗");
    }
    try {
      await this.compose(
        ["down", "--volumes", "--remove-orphans", "--timeout", "5"],
        60000,
      );
    } catch {
      errors.push("Compose環境の削除に失敗");
    }
    try {
      const image = `${this.project}-runtime`;
      const { stdout } = await exec("docker", ["image", "ls", "-q", image], {
        timeout: 10000,
      });
      if (stdout.trim())
        await exec("docker", ["image", "rm", image], { timeout: 15000 });
    } catch {
      errors.push("試験専用imageの削除に失敗");
    }
    for (const [kind, args] of [
      ["containers", ["ps", "-aq"]],
      ["volumes", ["volume", "ls", "-q"]],
      ["networks", ["network", "ls", "-q"]],
    ] as const) {
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
        if (stdout.trim()) errors.push(`${kind}が残った: ${stdout.trim()}`);
      } catch {
        errors.push(`${kind}のcleanup確認に失敗`);
      }
    }
    this.report.cleanup = { success: errors.length === 0, errors };
    this.report.finishedAt = new Date().toISOString();
    if (errors.length) this.report.status = "failed";
    await mkdir(this.directory, { recursive: true });
    await writeFile(resolve(this.directory, "commands.log"), this.transcript);
    await writeFile(
      resolve(this.directory, "result.json"),
      JSON.stringify(this.report, null, 2) + "\n",
    );
    console.log(`復旧E2E結果: ${this.directory}/result.json`);
    if (errors.length) throw new Error(errors.join("; "));
  }
}
