import { readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { protectTrustFile } from "./artifacts.js";
import { connectAsync } from "mqtt";
import { canonical, parseEnvelope } from "@drone-fleet/releases";
import { createDeviceMqttConnectionConfig } from "@drone-fleet/simulator/transport";
import { loadSimulatorConfig } from "@drone-fleet/simulator/config";
import { readConfig } from "./config.js";
import { bootstrap, Supervisor } from "./supervisor.js";
async function main() {
  const [path, mode, baseline] = process.argv.slice(2);
  if (!path) throw new Error("config required");
  const config = await readConfig(path);
  if (mode === "bootstrap") {
    if (!baseline) throw new Error("baseline required");
    const envelope = parseEnvelope(
      canonical(JSON.parse(await readFile(baseline, "utf8"))),
    );
    const { releaseId, digest, version, buildId } = envelope.manifest;
    await bootstrap(config, { releaseId, digest, version, buildId });
    return;
  }
  if (mode !== "serve") throw new Error("serve or bootstrap required");
  const transport = loadSimulatorConfig().mqttTransport;
  if (transport.type === "aws-iot") {
    const key = resolve(
      join(
        transport.deviceCredentialsDirectory,
        config.deviceId,
        "private.pem.key",
      ),
    );
    await protectTrustFile(key, config.data);
    if (((await lstat(key)).mode & 0o077) !== 0)
      throw new Error("private key is readable by child");
  }
  const connection = await createDeviceMqttConnectionConfig(
    transport,
    config.deviceId,
  );
  const client = await connectAsync(
    connection.url,
    {
      ...connection.clientOptions,
      reconnectPeriod: 1000,
      will: {
        topic: `fleet/v1/devices/${config.deviceId}/status`,
        payload: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            deviceId: config.deviceId,
            timestamp: new Date().toISOString(),
            payload: { status: "OFFLINE", reason: "CONNECTION_LOST" },
          }),
        ),
        qos: 1,
        retain: true,
      },
    },
    false,
  );
  const supervisor = new Supervisor(config, client);
  try {
    await supervisor.start();
  } catch (e) {
    await client.endAsync(true);
    throw e;
  }
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      if (!closing) {
        closing = true;
        void supervisor.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      }
    });
}
void main().catch(() => {
  console.error("OTA supervisorを開始できません。自動復旧せず確認を待ちます");
  process.exit(1);
});
