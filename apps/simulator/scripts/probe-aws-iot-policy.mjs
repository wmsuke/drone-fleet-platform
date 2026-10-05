#!/usr/bin/env node

/* global clearTimeout, console, process, setTimeout */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { connect, connectAsync } from "mqtt";

const TIMEOUT_MS = 10_000;

export class ProbeTimeoutError extends Error {}

function timeout(label, timeoutMs) {
  let timer;
  return {
    promise: new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new ProbeTimeoutError(`${label} timed out`)),
        timeoutMs,
      );
    }),
    cancel: () => clearTimeout(timer),
  };
}

async function loadConnection(endpoint, credentialsDirectory, deviceId) {
  const directory = join(credentialsDirectory, deviceId);
  const [ca, cert, key] = await Promise.all([
    readFile(join(credentialsDirectory, "AmazonRootCA1.pem")),
    readFile(join(directory, "device.pem.crt")),
    readFile(join(directory, "private.pem.key")),
  ]);
  return {
    url: `mqtts://${endpoint}:8883`,
    options: {
      ca,
      cert,
      clean: true,
      clientId: deviceId,
      key,
      reconnectPeriod: 0,
      rejectUnauthorized: true,
      servername: endpoint,
    },
  };
}

export async function expectRejected(operation, label, timeoutMs = TIMEOUT_MS) {
  const deadline = timeout(label, timeoutMs);
  try {
    await Promise.race([operation(), deadline.promise]);
  } catch (error) {
    if (error instanceof ProbeTimeoutError) {
      throw error;
    }
    return;
  } finally {
    deadline.cancel();
  }
  throw new Error(`${label} was unexpectedly allowed`);
}

function observeOperation(client, operation, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      client.off("close", onClose);
      client.off("error", onError);
    };
    const reject = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const onClose = () => reject(new Error(`${label} disconnected`));
    const onError = (error) => reject(error);
    client.once("close", onClose);
    client.once("error", onError);
    operation().then((value) => {
      cleanup();
      resolvePromise(value);
    }, reject);
  });
}

export async function verifyCrossDevicePolicy({
  endpoint,
  credentialsDirectory,
  sourceDeviceId,
  targetDeviceId,
}) {
  const connection = await loadConnection(
    endpoint,
    credentialsDirectory,
    sourceDeviceId,
  );

  const publishClient = await connectAsync(
    connection.url,
    connection.options,
    false,
  );
  publishClient.on("error", () => {});
  try {
    await expectRejected(
      () =>
        observeOperation(
          publishClient,
          () =>
            publishClient.publishAsync(
              `fleet/v1/devices/${targetDeviceId}/telemetry`,
              JSON.stringify({
                schemaVersion: 1,
                deviceId: targetDeviceId,
                sequence: 0,
                timestamp: new Date().toISOString(),
                payload: {
                  battery: 100,
                  latitude: 0,
                  longitude: 0,
                  altitude: 0,
                  temperature: 20,
                  status: "IDLE",
                },
              }),
              { qos: 1, retain: false },
            ),
          "cross-device publish",
        ),
      "cross-device publish",
    );
  } finally {
    await publishClient.endAsync(true).catch(() => {});
  }

  const subscribeClient = await connectAsync(
    connection.url,
    connection.options,
    false,
  );
  subscribeClient.on("error", () => {});
  try {
    await expectRejected(
      () =>
        observeOperation(
          subscribeClient,
          () =>
            subscribeClient.subscribeAsync(
              `fleet/v1/devices/${targetDeviceId}/commands`,
              { qos: 1 },
            ),
          "cross-device subscribe",
        ),
      "cross-device subscribe",
    );
  } finally {
    await subscribeClient.endAsync(true).catch(() => {});
  }
}

export async function verifyCertificateRejected({
  endpoint,
  credentialsDirectory,
  deviceId,
}) {
  const connection = await loadConnection(
    endpoint,
    credentialsDirectory,
    deviceId,
  );
  await expectRejected(
    () =>
      new Promise((resolvePromise, rejectPromise) => {
        const client = connect(connection.url, connection.options);
        let accepted = false;
        client.once("connect", () => {
          accepted = true;
          client.end(true, {}, resolvePromise);
        });
        client.once("error", rejectPromise);
        client.once("close", () => {
          if (!accepted) {
            rejectPromise(new Error("inactive certificate connection closed"));
          }
        });
      }),
    "inactive certificate connection",
  );
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      endpoint: { type: "string" },
      "credentials-dir": { type: "string", default: "secrets/aws-iot" },
      "source-device-id": { type: "string" },
      "target-device-id": { type: "string" },
      "device-id": { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.endpoint === undefined) {
    throw new TypeError("--endpoint is required");
  }
  if (command === "cross-device") {
    if (
      values["source-device-id"] === undefined ||
      values["target-device-id"] === undefined ||
      values["source-device-id"] === values["target-device-id"]
    ) {
      throw new TypeError(
        "different source and target device IDs are required",
      );
    }
    await verifyCrossDevicePolicy({
      endpoint: values.endpoint,
      credentialsDirectory: values["credentials-dir"],
      sourceDeviceId: values["source-device-id"],
      targetDeviceId: values["target-device-id"],
    });
    console.log("他機体topicへのpublish / subscribe拒否を確認しました");
    return;
  }
  if (command === "inactive-certificate") {
    if (values["device-id"] === undefined) {
      throw new TypeError("--device-id is required");
    }
    await verifyCertificateRejected({
      endpoint: values.endpoint,
      credentialsDirectory: values["credentials-dir"],
      deviceId: values["device-id"],
    });
    console.log("無効な証明書の接続拒否を確認しました");
    return;
  }
  throw new TypeError("command must be cross-device or inactive-certificate");
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  main().catch((error) => {
    console.error(`AWS IoT Policy検証に失敗しました: ${error.message}`);
    process.exitCode = 1;
  });
}
