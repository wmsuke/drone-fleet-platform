import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  issueDeviceCertificate,
  revokeDeviceCertificate,
  verifyDeviceCredentialFiles,
} from "./manage-aws-iot-certificate.mjs";

const temporaryDirectories = [];

function createFakeExecute(options = {}) {
  let certificateSequence = 0;
  const statuses = new Map();
  const principals = new Map();
  const policies = new Map();
  const calls = [];

  const execute = vi.fn(async (command, arguments_) => {
    calls.push({ command, arguments_ });
    if (command === "git") {
      return { exitCode: 1, stdout: "" };
    }
    if (command === "openssl") {
      const keyPath = arguments_[arguments_.indexOf("-keyout") + 1];
      const csrPath = arguments_[arguments_.indexOf("-out") + 1];
      await writeFile(keyPath, "TEST-PRIVATE-KEY", { mode: 0o600 });
      await writeFile(csrPath, "TEST-CSR", { mode: 0o600 });
      return { exitCode: 0, stdout: "" };
    }
    if (command !== "aws") throw new Error(`unexpected command: ${command}`);

    const operation = arguments_[1];
    const valueAfter = (name) => arguments_[arguments_.indexOf(name) + 1] ?? "";
    if (operation === "describe-thing") {
      return { exitCode: 0, stdout: "{}" };
    }
    if (operation === "list-thing-principals") {
      const thingName = valueAfter("--thing-name");
      const result =
        principals.get(thingName) ??
        (options.existingPrincipal === undefined
          ? []
          : [options.existingPrincipal]);
      return { exitCode: 0, stdout: JSON.stringify({ principals: result }) };
    }
    if (operation === "create-certificate-from-csr") {
      certificateSequence += 1;
      const certificateId = certificateSequence.toString(16).padStart(64, "0");
      const certificateArn = `arn:aws:iot:ap-northeast-1:123456789012:cert/${certificateId}`;
      statuses.set(certificateId, "ACTIVE");
      policies.set(certificateArn, []);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          certificateArn,
          certificateId,
          certificatePem: `TEST-CERTIFICATE-${certificateSequence}`,
        }),
      };
    }
    if (operation === "attach-thing-principal") {
      if (options.failAttach === true) throw new Error("aws failed");
      principals.set(valueAfter("--thing-name"), [valueAfter("--principal")]);
      return { exitCode: 0, stdout: "{}" };
    }
    if (operation === "list-attached-policies") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          policies: policies.get(valueAfter("--target")) ?? [],
        }),
      };
    }
    if (operation === "detach-policy") {
      policies.set(valueAfter("--target"), []);
      return { exitCode: 0, stdout: "{}" };
    }
    if (operation === "detach-thing-principal") {
      principals.set(valueAfter("--thing-name"), []);
      return { exitCode: 0, stdout: "{}" };
    }
    if (operation === "describe-certificate") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          certificateDescription: {
            status: statuses.get(valueAfter("--certificate-id")),
          },
        }),
      };
    }
    if (operation === "update-certificate") {
      statuses.set(valueAfter("--certificate-id"), valueAfter("--new-status"));
      return { exitCode: 0, stdout: "{}" };
    }
    if (operation === "delete-certificate") {
      statuses.delete(valueAfter("--certificate-id"));
      return { exitCode: 0, stdout: "{}" };
    }
    throw new Error(`unexpected AWS operation: ${operation}`);
  });

  return { execute, calls, policies };
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "aws-iot-certificates-"));
  temporaryDirectories.push(directory);
  const outputDirectory = join(directory, "credentials");
  const rootCaPath = join(directory, "AmazonRootCA1.pem");
  await writeFile(rootCaPath, "TEST-ROOT-CA", { mode: 0o600 });
  return { outputDirectory, rootCaPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("AWS IoT device certificate management", () => {
  it("issues different certificates for two Things with protected files", async () => {
    const fixture = await createFixture();
    const fake = createFakeExecute();
    const baseOptions = {
      outputDirectory: fixture.outputDirectory,
      rootCaPath: fixture.rootCaPath,
      region: "ap-northeast-1",
    };

    const first = await issueDeviceCertificate(
      { ...baseOptions, deviceId: "dev-drone-001" },
      { execute: fake.execute, now: () => new Date("2026-10-03T00:00:00Z") },
    );
    const second = await issueDeviceCertificate(
      { ...baseOptions, deviceId: "dev-drone-002" },
      { execute: fake.execute, now: () => new Date("2026-10-03T00:00:01Z") },
    );

    expect(first.certificateId).not.toBe(second.certificateId);
    for (const deviceId of ["dev-drone-001", "dev-drone-002"]) {
      await verifyDeviceCredentialFiles(
        { ...baseOptions, deviceId },
        { execute: fake.execute },
      );
      const deviceDirectory = join(fixture.outputDirectory, deviceId);
      expect((await stat(deviceDirectory)).mode & 0o777).toBe(0o700);
      expect(
        (await stat(join(deviceDirectory, "private.pem.key"))).mode & 0o777,
      ).toBe(0o600);
      expect(
        await readFile(join(deviceDirectory, "manifest.json"), "utf8"),
      ).not.toContain("TEST-PRIVATE-KEY");
    }
    expect(JSON.stringify(fake.calls)).not.toContain("TEST-PRIVATE-KEY");
    expect(JSON.stringify(fake.calls)).not.toContain("TEST-CERTIFICATE");
    const createCalls = fake.calls.filter(
      ({ arguments_ }) => arguments_[1] === "create-certificate-from-csr",
    );
    expect(createCalls).toHaveLength(2);
    for (const { arguments_ } of createCalls) {
      expect(
        arguments_[arguments_.indexOf("--certificate-signing-request") + 1],
      ).toMatch(/^file:\/\//);
    }
  });

  it("rejects local and remote duplicate issuance", async () => {
    const fixture = await createFixture();
    const baseOptions = {
      deviceId: "dev-drone-001",
      outputDirectory: fixture.outputDirectory,
      rootCaPath: fixture.rootCaPath,
      region: "ap-northeast-1",
    };
    const fake = createFakeExecute();
    await issueDeviceCertificate(baseOptions, { execute: fake.execute });
    await expect(
      issueDeviceCertificate(baseOptions, { execute: fake.execute }),
    ).rejects.toThrow("credentials already exist");

    const otherFixture = await createFixture();
    const remoteDuplicate = createFakeExecute({
      existingPrincipal:
        "arn:aws:iot:ap-northeast-1:123456789012:cert/existing",
    });
    await expect(
      issueDeviceCertificate(
        {
          ...baseOptions,
          outputDirectory: otherFixture.outputDirectory,
          rootCaPath: otherFixture.rootCaPath,
        },
        { execute: remoteDuplicate.execute },
      ),
    ).rejects.toThrow("already has a principal");
  });

  it("detaches policies and Thing, deactivates, deletes, and removes local files", async () => {
    const fixture = await createFixture();
    const fake = createFakeExecute();
    const options = {
      deviceId: "dev-drone-001",
      outputDirectory: fixture.outputDirectory,
      rootCaPath: fixture.rootCaPath,
      region: "ap-northeast-1",
    };
    const issued = await issueDeviceCertificate(options, {
      execute: fake.execute,
    });
    const manifest = JSON.parse(
      await readFile(join(issued.deviceDirectory, "manifest.json"), "utf8"),
    );
    fake.policies.set(manifest.certificateArn, [
      { policyName: "drone-fleet-dev-device" },
    ]);

    await revokeDeviceCertificate(options, { execute: fake.execute });

    await expect(stat(issued.deviceDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const operations = fake.calls
      .filter(({ command }) => command === "aws")
      .map(({ arguments_ }) => arguments_[1]);
    expect(operations).toEqual(
      expect.arrayContaining([
        "detach-policy",
        "detach-thing-principal",
        "update-certificate",
        "delete-certificate",
      ]),
    );
  });

  it("cleans up the issued certificate when Thing attachment fails", async () => {
    const fixture = await createFixture();
    const fake = createFakeExecute({ failAttach: true });
    const options = {
      deviceId: "dev-drone-001",
      outputDirectory: fixture.outputDirectory,
      rootCaPath: fixture.rootCaPath,
      region: "ap-northeast-1",
    };

    await expect(
      issueDeviceCertificate(options, { execute: fake.execute }),
    ).rejects.toThrow("aws iot attach-thing-principal failed");
    await expect(
      stat(join(fixture.outputDirectory, options.deviceId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const operations = fake.calls
      .filter(({ command }) => command === "aws")
      .map(({ arguments_ }) => arguments_[1]);
    expect(operations).toEqual(
      expect.arrayContaining(["update-certificate", "delete-certificate"]),
    );
  });

  it("rejects a manifest whose certificate ARN does not match its ID", async () => {
    const fixture = await createFixture();
    const fake = createFakeExecute();
    const options = {
      deviceId: "dev-drone-001",
      outputDirectory: fixture.outputDirectory,
      rootCaPath: fixture.rootCaPath,
      region: "ap-northeast-1",
    };
    const issued = await issueDeviceCertificate(options, {
      execute: fake.execute,
    });
    const manifestPath = join(issued.deviceDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.certificateArn = manifest.certificateArn.replace(
      manifest.certificateId,
      "f".repeat(64),
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, {
      mode: 0o600,
    });

    await expect(
      revokeDeviceCertificate(options, { execute: fake.execute }),
    ).rejects.toThrow("manifest does not match");
    expect(
      fake.calls.some(
        ({ arguments_ }) => arguments_[1] === "list-attached-policies",
      ),
    ).toBe(false);
  });
});
