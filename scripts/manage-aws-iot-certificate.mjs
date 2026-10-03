#!/usr/bin/env node

/* global Buffer, console, process */

import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/;
const CERTIFICATE_ID_PATTERN = /^[a-fA-F0-9]{64}$/;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

function defaultExecute(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stdoutBytes = 0;

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        rejectPromise(new Error(`${command} returned too much output`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () =>
      rejectPromise(new Error(`${command} could not start`)),
    );
    child.on("close", (exitCode) => {
      if (exitCode !== 0 && options.allowFailure !== true) {
        rejectPromise(
          new Error(`${command} failed with exit code ${exitCode}`),
        );
        return;
      }
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

function validateOptions({ deviceId, outputDirectory, region }) {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new TypeError(
      "deviceId must be 1-64 letters, numbers, hyphens, or underscores",
    );
  }
  if (!REGION_PATTERN.test(region)) {
    throw new TypeError("region must be a valid AWS region name");
  }
  const resolvedOutput = resolve(outputDirectory);
  const forbidden = new Set([
    parse(resolvedOutput).root,
    resolve(homedir()),
    resolve(process.cwd()),
  ]);
  if (forbidden.has(resolvedOutput)) {
    throw new TypeError("outputDirectory must be a dedicated subdirectory");
  }
  return resolvedOutput;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular file`);
  }
  if (metadata.uid !== process.getuid?.()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be writable by group or others`);
  }
}

async function assertFileMode(path, label, expectedMode) {
  await assertRegularFile(path, label);
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== expectedMode) {
    throw new Error(`${label} must have mode ${expectedMode.toString(8)}`);
  }
}

async function assertDirectoryMode(path, expectedMode) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`${path} must be a directory and not a symbolic link`);
  }
  if (metadata.uid !== process.getuid?.()) {
    throw new Error(`${path} must be owned by the current user`);
  }
  if ((metadata.mode & 0o777) !== expectedMode) {
    throw new Error(`${path} must have mode ${expectedMode.toString(8)}`);
  }
}

async function assertIgnoredByGit(path, execute) {
  const rootResult = await execute("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    allowFailure: true,
  });
  if (rootResult.exitCode !== 0) return;

  const gitRoot = resolve(rootResult.stdout.trim());
  const target = resolve(path);
  const targetRelative = relative(gitRoot, target);
  if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) return;

  const ignored = await execute(
    "git",
    ["check-ignore", "--quiet", "--no-index", target],
    { cwd: gitRoot, allowFailure: true },
  );
  if (ignored.exitCode !== 0) {
    throw new Error(
      `${target} must be ignored by Git before credentials are created`,
    );
  }
}

async function runAws(execute, region, arguments_) {
  try {
    return await execute(
      "aws",
      ["iot", ...arguments_, "--region", region, "--output", "json"],
      {},
    );
  } catch (error) {
    throw new Error(`aws iot ${arguments_[0]} failed`, { cause: error });
  }
}

function parseJson(output, operation) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

async function cleanupIssuedCertificate(
  { certificateArn, certificateId, deviceId, region, attached },
  execute,
) {
  if (certificateId === undefined || certificateArn === undefined) return;
  if (attached) {
    await runAws(execute, region, [
      "detach-thing-principal",
      "--thing-name",
      deviceId,
      "--principal",
      certificateArn,
    ]).catch(() => undefined);
  }
  await runAws(execute, region, [
    "update-certificate",
    "--certificate-id",
    certificateId,
    "--new-status",
    "INACTIVE",
  ]).catch(() => undefined);
  await runAws(execute, region, [
    "delete-certificate",
    "--certificate-id",
    certificateId,
  ]).catch(() => undefined);
}

export async function verifyDeviceCredentialFiles(options, dependencies = {}) {
  const execute = dependencies.execute ?? defaultExecute;
  const outputRoot = validateOptions(options);
  const deviceDirectory = join(outputRoot, options.deviceId);
  await assertIgnoredByGit(outputRoot, execute);
  await assertDirectoryMode(outputRoot, 0o700);
  await assertDirectoryMode(deviceDirectory, 0o700);
  await assertFileMode(options.rootCaPath, "root CA", 0o600);

  for (const [name, label] of [
    ["private.pem.key", "private key"],
    ["device.pem.crt", "device certificate"],
    ["manifest.json", "certificate manifest"],
  ]) {
    const path = join(deviceDirectory, name);
    await assertFileMode(path, label, 0o600);
  }

  return { deviceId: options.deviceId, deviceDirectory };
}

export async function issueDeviceCertificate(options, dependencies = {}) {
  const execute = dependencies.execute ?? defaultExecute;
  const now = dependencies.now ?? (() => new Date());
  const outputRoot = validateOptions(options);
  const deviceDirectory = join(outputRoot, options.deviceId);
  await assertFileMode(options.rootCaPath, "root CA", 0o600);
  await assertIgnoredByGit(outputRoot, execute);

  const outputExists = await pathExists(outputRoot);
  if (!outputExists) {
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  }
  await assertDirectoryMode(outputRoot, 0o700);
  if (await pathExists(deviceDirectory)) {
    throw new Error(`credentials already exist for ${options.deviceId}`);
  }

  await runAws(execute, options.region, [
    "describe-thing",
    "--thing-name",
    options.deviceId,
  ]);
  const principalsResult = await runAws(execute, options.region, [
    "list-thing-principals",
    "--thing-name",
    options.deviceId,
  ]);
  const principals = parseJson(
    principalsResult.stdout,
    "list-thing-principals",
  ).principals;
  if (!Array.isArray(principals)) {
    throw new Error("list-thing-principals returned an invalid response");
  }
  if (principals.length > 0) {
    throw new Error(`Thing ${options.deviceId} already has a principal`);
  }

  const temporaryDirectory = await mkdtemp(
    join(outputRoot, `.issue-${options.deviceId}-`),
  );
  await chmod(temporaryDirectory, 0o700);
  const privateKeyPath = join(temporaryDirectory, "private.pem.key");
  const csrPath = join(temporaryDirectory, "device.csr");
  const certificatePath = join(temporaryDirectory, "device.pem.crt");
  const manifestPath = join(temporaryDirectory, "manifest.json");
  const issued = {
    deviceId: options.deviceId,
    region: options.region,
    attached: false,
  };

  try {
    await execute(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        privateKeyPath,
        "-out",
        csrPath,
        "-subj",
        `/CN=${options.deviceId}`,
      ],
      {},
    );
    await chmod(privateKeyPath, 0o600);
    await chmod(csrPath, 0o600);

    const certificateResult = await runAws(execute, options.region, [
      "create-certificate-from-csr",
      "--certificate-signing-request",
      `file://${csrPath}`,
      "--set-as-active",
    ]);
    const certificate = parseJson(
      certificateResult.stdout,
      "create-certificate-from-csr",
    );
    if (
      typeof certificate.certificateArn !== "string" ||
      typeof certificate.certificateId !== "string" ||
      typeof certificate.certificatePem !== "string" ||
      !certificateIdentityMatches(
        certificate.certificateArn,
        certificate.certificateId,
        options.region,
      )
    ) {
      throw new Error(
        "create-certificate-from-csr returned an invalid response",
      );
    }
    issued.certificateArn = certificate.certificateArn;
    issued.certificateId = certificate.certificateId;

    await writeFile(certificatePath, certificate.certificatePem, {
      encoding: "utf8",
      mode: 0o600,
    });
    const manifest = {
      schemaVersion: 1,
      deviceId: options.deviceId,
      thingName: options.deviceId,
      region: options.region,
      certificateArn: certificate.certificateArn,
      certificateId: certificate.certificateId,
      createdAt: now().toISOString(),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    await runAws(execute, options.region, [
      "attach-thing-principal",
      "--thing-name",
      options.deviceId,
      "--principal",
      certificate.certificateArn,
      "--thing-principal-type",
      "EXCLUSIVE_THING",
    ]);
    issued.attached = true;
    await rm(csrPath);
    await rename(temporaryDirectory, deviceDirectory);
    await verifyDeviceCredentialFiles(options, { execute });
    return {
      deviceId: options.deviceId,
      certificateId: certificate.certificateId,
      deviceDirectory,
    };
  } catch (error) {
    await cleanupIssuedCertificate(issued, execute);
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function certificateIdentityMatches(certificateArn, certificateId, region) {
  if (!CERTIFICATE_ID_PATTERN.test(certificateId)) return false;
  const arnMatch = certificateArn.match(
    /^arn:[a-z0-9-]+:iot:([a-z0-9-]+):[0-9]{12}:cert\/([a-fA-F0-9]{64})$/,
  );
  return (
    arnMatch !== null && arnMatch[1] === region && arnMatch[2] === certificateId
  );
}

function validateManifest(value, deviceId, region) {
  if (
    value?.schemaVersion !== 1 ||
    value.deviceId !== deviceId ||
    value.thingName !== deviceId ||
    value.region !== region ||
    typeof value.certificateArn !== "string" ||
    typeof value.certificateId !== "string" ||
    !certificateIdentityMatches(
      value.certificateArn,
      value.certificateId,
      region,
    )
  ) {
    throw new Error("certificate manifest does not match the requested device");
  }
  return value;
}

export async function revokeDeviceCertificate(options, dependencies = {}) {
  const execute = dependencies.execute ?? defaultExecute;
  const outputRoot = validateOptions(options);
  const deviceDirectory = join(outputRoot, options.deviceId);
  await assertIgnoredByGit(outputRoot, execute);
  await assertDirectoryMode(outputRoot, 0o700);
  await assertDirectoryMode(deviceDirectory, 0o700);
  const manifestPath = join(deviceDirectory, "manifest.json");
  await assertFileMode(manifestPath, "certificate manifest", 0o600);
  const manifest = validateManifest(
    parseJson(await readFile(manifestPath, "utf8"), "certificate manifest"),
    options.deviceId,
    options.region,
  );

  const policiesResult = await runAws(execute, options.region, [
    "list-attached-policies",
    "--target",
    manifest.certificateArn,
  ]);
  const policies = parseJson(
    policiesResult.stdout,
    "list-attached-policies",
  ).policies;
  if (!Array.isArray(policies)) {
    throw new Error("list-attached-policies returned an invalid response");
  }
  for (const policy of policies) {
    if (typeof policy.policyName !== "string") {
      throw new Error("list-attached-policies returned an invalid policy");
    }
    await runAws(execute, options.region, [
      "detach-policy",
      "--policy-name",
      policy.policyName,
      "--target",
      manifest.certificateArn,
    ]);
  }

  const principalsResult = await runAws(execute, options.region, [
    "list-thing-principals",
    "--thing-name",
    options.deviceId,
  ]);
  const principals = parseJson(
    principalsResult.stdout,
    "list-thing-principals",
  ).principals;
  if (!Array.isArray(principals)) {
    throw new Error("list-thing-principals returned an invalid response");
  }
  if (principals.includes(manifest.certificateArn)) {
    await runAws(execute, options.region, [
      "detach-thing-principal",
      "--thing-name",
      options.deviceId,
      "--principal",
      manifest.certificateArn,
    ]);
  }

  const descriptionResult = await runAws(execute, options.region, [
    "describe-certificate",
    "--certificate-id",
    manifest.certificateId,
  ]);
  const status = parseJson(descriptionResult.stdout, "describe-certificate")
    .certificateDescription?.status;
  if (status === "ACTIVE") {
    await runAws(execute, options.region, [
      "update-certificate",
      "--certificate-id",
      manifest.certificateId,
      "--new-status",
      "INACTIVE",
    ]);
  } else if (status !== "INACTIVE" && status !== "REVOKED") {
    throw new Error(
      `certificate cannot be deleted from status ${String(status)}`,
    );
  }

  await runAws(execute, options.region, [
    "delete-certificate",
    "--certificate-id",
    manifest.certificateId,
  ]);
  await rm(deviceDirectory, { recursive: true });
  return { deviceId: options.deviceId, certificateId: manifest.certificateId };
}

function printUsage() {
  console.log(`Usage:
  node scripts/manage-aws-iot-certificate.mjs issue --device-id <id> --output-dir <dir> --root-ca <path> [--region <region>]
  node scripts/manage-aws-iot-certificate.mjs verify --device-id <id> --output-dir <dir> --root-ca <path> [--region <region>]
  node scripts/manage-aws-iot-certificate.mjs revoke --device-id <id> --output-dir <dir> [--region <region>]`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      "device-id": { type: "string" },
      "output-dir": { type: "string", default: "secrets/aws-iot" },
      "root-ca": { type: "string" },
      region: {
        type: "string",
        default:
          process.env.AWS_REGION ??
          process.env.AWS_DEFAULT_REGION ??
          "ap-northeast-1",
      },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    printUsage();
    return;
  }
  const command = positionals[0];
  if (
    !["issue", "verify", "revoke"].includes(command) ||
    values["device-id"] === undefined
  ) {
    printUsage();
    throw new TypeError("command and --device-id are required");
  }
  const options = {
    deviceId: values["device-id"],
    outputDirectory: values["output-dir"],
    region: values.region,
    rootCaPath: values["root-ca"],
  };

  if (command !== "revoke" && options.rootCaPath === undefined) {
    throw new TypeError("--root-ca is required for issue and verify");
  }
  if (command === "issue") {
    await issueDeviceCertificate(options);
    console.log(`証明書を発行しました: ${options.deviceId}`);
  } else if (command === "verify") {
    await verifyDeviceCredentialFiles(options);
    console.log(`認証情報の配置と権限を確認しました: ${options.deviceId}`);
  } else {
    await revokeDeviceCertificate(options);
    console.log(`証明書を失効・削除しました: ${options.deviceId}`);
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  main().catch((error) => {
    console.error(`証明書操作に失敗しました: ${error.message}`);
    process.exitCode = 1;
  });
}
