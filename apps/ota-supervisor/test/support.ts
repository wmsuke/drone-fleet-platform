import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomUUID, sign, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, chmod, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonical,
  packBundle,
  digestOf,
  type Envelope,
} from "@drone-fleet/releases";
import {
  serializeOtaEvent,
  serializeOtaInventory,
  type OtaApplyRequest,
} from "@drone-fleet/protocol";
import type { SimulatorMqttClient } from "@drone-fleet/simulator";
import { bundleSimulator } from "../src/bundle.js";
import type { SupervisorConfig } from "../src/supervisor.js";

export const pair = generateKeyPairSync("ed25519");
export function makeEnvelope(
  bytes: Buffer,
  version = "0.1.0",
  releaseId = randomUUID(),
): Envelope {
  const manifest = {
    schemaVersion: 1 as const,
    releaseId,
    application: "simulator" as const,
    version,
    buildId: `build-${version}`,
    platform: `linux-${process.arch}` as "linux-arm64",
    nodeRange: ">=22.13.0 <23",
    otaProtocolRange: "^1.0.0",
    supervisorRange: "^1.0.0",
    stateSchemaRange: "1.0.0",
    digest: digestOf(bytes),
    size: bytes.length,
    entrypoint: "app/main.mjs" as const,
    healthContractVersion: "ota-health-v1" as const,
    rollbackCompatible: true,
  };
  return {
    manifest,
    keyId: "test",
    algorithm: "Ed25519",
    signature: sign(
      null,
      Buffer.from(canonical(manifest)),
      pair.privateKey,
    ).toString("base64"),
  };
}
export const identity = (e: Envelope) => {
  const { releaseId, digest, version, buildId } = e.manifest;
  return { releaseId, digest, version, buildId };
};
export function applyRequest(envelope: Envelope, fence = "1"): OtaApplyRequest {
  const now = Date.now();
  return {
    schemaVersion: 1,
    deviceId: "ota-test",
    deploymentId: randomUUID(),
    stageId: randomUUID(),
    targetId: randomUUID(),
    attemptId: randomUUID(),
    commandId: randomUUID(),
    fence,
    release: identity(envelope),
    type: "APPLY_RELEASE",
    purpose: "APPLY",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
    resultDeadline: new Date(now + 600000).toISOString(),
    evaluationVersion: "ota-health-v1",
  };
}
export class Broker extends EventEmitter {
  connected = true;
  options = {};
  messages: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  receiptEnabled = true;
  async subscribeAsync(topic: string) {
    return [{ topic, qos: 1 }];
  }
  async publishAsync(topic: string, payload: string) {
    const value = JSON.parse(payload);
    this.messages.push({ topic, payload: value });
    if (!this.receiptEnabled) return;
    if (topic.endsWith("/telemetry"))
      setImmediate(() =>
        this.emit(
          "message",
          topic.replace(/telemetry$/, "telemetry-receipts"),
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              deviceId: value.deviceId,
              sessionId: value.sessionId,
              sequence: value.sequence,
              timestamp: new Date().toISOString(),
              status: "STORED",
            }),
          ),
          { qos: 1, retain: false },
        ),
      );
    if (topic.endsWith("/ota-events")) {
      if (value.type === "INVENTORY") {
        setImmediate(() =>
          this.emit(
            "message",
            topic.replace(/ota-events$/, "ota-receipts"),
            Buffer.from(
              JSON.stringify({
                schemaVersion: 1,
                type: "INVENTORY",
                deviceId: value.deviceId,
                eventId: value.eventId,
                payloadHash: createHash("sha256")
                  .update(serializeOtaInventory(value))
                  .digest("hex"),
                status: "STORED",
                receivedAt: new Date().toISOString(),
                storedAt: new Date().toISOString(),
              }),
            ),
            { qos: 1, retain: false },
          ),
        );
        return;
      }
      const {
        schemaVersion,
        deviceId,
        deploymentId,
        stageId,
        targetId,
        attemptId,
        fence,
        release,
        eventId,
      } = value;
      setImmediate(() =>
        this.emit(
          "message",
          topic.replace(/ota-events$/, "ota-receipts"),
          Buffer.from(
            JSON.stringify({
              schemaVersion,
              deviceId,
              deploymentId,
              stageId,
              targetId,
              attemptId,
              fence,
              release,
              eventId,
              status: "STORED",
              payloadHash: createHash("sha256")
                .update(serializeOtaEvent(value))
                .digest("hex"),
              receivedAt: new Date().toISOString(),
              storedAt: new Date().toISOString(),
            }),
          ),
          { qos: 1, retain: false },
        ),
      );
    }
  }
  async endAsync() {
    this.connected = false;
    this.emit("close");
  }
  reconnect() {
    this.connected = true;
    setImmediate(() => this.emit("connect"));
    return this;
  }
  client() {
    return this as unknown as SimulatorMqttClient;
  }
}
export async function fixture(realBundle = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ota-device-test-")),
  );
  await chmod(root, 0o755);
  const releases = new Map<string, Envelope>();
  const archives = new Map<string, Buffer>();
  async function add(version: string, behavior: string) {
    const releaseId = randomUUID();
    const bytes = packBundle(
      realBundle
        ? await bundleSimulator({
            releaseId,
            version,
            buildId: `build-${version}`,
            behavior,
            temperatureOffset: version === "0.1.0" ? 0 : 4,
          })
        : Buffer.from("console.info('fixture');"),
    );
    const envelope = makeEnvelope(bytes, version, releaseId);
    releases.set(releaseId, envelope);
    archives.set(envelope.manifest.digest, bytes);
    return envelope;
  }
  const baseline = await add("0.1.0", "baseline");
  const candidate = await add("0.2.0", "updated");
  const server = createServer((req, res) => {
    const id = req.url?.split("/").at(-1) ?? "";
    if (req.url?.startsWith("/releases/") && releases.has(id))
      res.end(JSON.stringify({ envelope: releases.get(id) }));
    else if (
      req.url?.startsWith("/objects/") &&
      archives.has(id.replace(/\.tar\.gz$/, ""))
    )
      res.end(archives.get(id.replace(/\.tar\.gz$/, "")));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen");
  await mkdir(join(root, "trust"), { mode: 0o700 });
  const trustPath = join(root, "trust/keys.json");
  await writeFile(
    trustPath,
    JSON.stringify({
      keys: [
        {
          keyId: "test",
          publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
          revoked: false,
        },
      ],
    }),
  );
  const source = {
    origin: `http://127.0.0.1:${address.port}`,
    allowedCidrs: ["127.0.0.1/32"],
    localHttp: true,
  };
  const config: SupervisorConfig = {
    deviceId: "ota-test",
    root: join(root, "state"),
    data: join(root, "data"),
    trustPath,
    metadataSource: source,
    artifactSource: source,
    clockTrusted: true,
    telemetryIntervalMs: 250,
  };
  return { root, config, baseline, candidate, releases, archives, server };
}
