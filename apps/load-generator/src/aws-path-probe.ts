import { createTelemetryTopic } from "@drone-fleet/protocol";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { connectAsync } from "mqtt";

import { createLoadTelemetry } from "./telemetry.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.AWS_IOT_FREE_TIER_CONFIRMED !== "true") {
    throw new TypeError(
      "AWS_IOT_FREE_TIER_CONFIRMED must be true after checking Billing",
    );
  }

  const endpoint = required("AWS_IOT_ENDPOINT");
  const ruleName = required("AWS_IOT_RULE_NAME");
  const deviceId = process.env.AWS_IOT_PROBE_DEVICE_ID ?? "load-probe";
  const timeoutMs = Number(process.env.AWS_IOT_PROBE_TIMEOUT_MS ?? "15000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError(
      "AWS_IOT_PROBE_TIMEOUT_MS must be between 1 and 60000",
    );
  }

  const client = await connectAsync(`mqtts://${endpoint}:8883`, {
    clientId: deviceId,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: timeoutMs,
    protocol: "mqtts",
    rejectUnauthorized: true,
    ca: await readFile(required("AWS_IOT_ROOT_CA_PATH")),
    cert: await readFile(required("AWS_IOT_PROBE_CERTIFICATE_PATH")),
    key: await readFile(required("AWS_IOT_PROBE_PRIVATE_KEY_PATH")),
  });

  const sourceTopic = createTelemetryTopic(deviceId);
  const verifiedTopic = `verified/${sourceTopic}`;
  const basicIngestTopic = `$aws/rules/${ruleName}/${sourceTopic}`;
  const sentAt = new Date();
  const telemetry = createLoadTelemetry(
    deviceId,
    randomUUID(),
    0,
    sentAt.toISOString(),
    "aws-path-probe",
  );

  try {
    await client.subscribeAsync(verifiedTopic, { qos: 0 });
    const arrival = new Promise<Date>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${verifiedTopic}`)),
        timeoutMs,
      );
      client.on("message", (topic, payload) => {
        if (topic !== verifiedTopic) return;
        const received = JSON.parse(payload.toString()) as {
          deviceId?: string;
        };
        if (received.deviceId !== deviceId) return;
        clearTimeout(timer);
        resolve(new Date());
      });
    });
    await client.publishAsync(basicIngestTopic, JSON.stringify(telemetry), {
      qos: 0,
      retain: false,
    });
    const receivedAt = await arrival;
    const report = {
      schemaVersion: 1,
      endpoint,
      ruleName,
      deviceId,
      basicIngestTopic,
      verifiedTopic,
      sentAt: sentAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
      latencyMs: receivedAt.getTime() - sentAt.getTime(),
    };
    const reportPath =
      process.env.AWS_IOT_PROBE_REPORT_PATH ??
      "load-results/aws-iot-path-probe.json";
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`AWS IoT経路を確認しました: ${reportPath}`);
  } finally {
    await client.endAsync(false);
  }
}

main().catch((error: unknown) => {
  console.error("AWS IoT経路の確認に失敗しました", error);
  process.exitCode = 1;
});
