import { generateKeyPairSync, sign } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
  symlink,
  realpath,
  chmod,
  open,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonical,
  parseEnvelope,
  parseTrustStore,
  verifyEnvelope,
  type Manifest,
  type Envelope,
} from "../src/manifest.js";
import { packBundle, verifyArchive } from "../src/archive.js";
import {
  digestOf,
  publishArtifact,
  readArtifact,
  verifyStoredArtifact,
} from "../src/store.js";
import { createArtifactServer } from "../src/server.js";

const pair = generateKeyPairSync("ed25519");
const trustText = JSON.stringify({
  keys: [
    {
      keyId: "test",
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
      revoked: false,
    },
  ],
});
const keys = parseTrustStore(trustText);
const archive = packBundle(Buffer.from('console.info("v1");'));
const manifest: Manifest = {
  schemaVersion: 1,
  releaseId: "90c85252-a66e-4f6d-8d4b-137a4a1b2e35",
  application: "simulator",
  version: "0.1.0",
  buildId: "test",
  platform: "linux-arm64",
  nodeRange: ">=22.13.0 <23",
  otaProtocolRange: "^1.0.0",
  supervisorRange: "^1.0.0",
  stateSchemaRange: "1.0.0",
  digest: digestOf(archive),
  size: archive.length,
  entrypoint: "app/main.mjs",
  healthContractVersion: "ota-health-v1",
  rollbackCompatible: true,
};
function signed(m = manifest): Envelope {
  return {
    manifest: m,
    keyId: "test",
    algorithm: "Ed25519",
    signature: sign(null, Buffer.from(canonical(m)), pair.privateKey).toString(
      "base64",
    ),
  };
}
const directories: string[] = [];
async function directory() {
  const d = await realpath(await mkdtemp(join(tmpdir(), "releases-test-")));
  directories.push(d);
  return d;
}
afterEach(async () => {
  for (const d of directories.splice(0))
    await rm(d, { recursive: true, force: true });
});
function mutatedHeader(change: (header: Buffer) => void) {
  const tar = gunzipSync(archive);
  change(tar.subarray(0, 512));
  tar.fill(32, 148, 156);
  const sum = tar.subarray(0, 512).reduce((s, v) => s + v, 0);
  tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(tar);
}
describe("signed release", () => {
  it("canonical roundtrip and known Ed25519 trust root", () => {
    expect(parseEnvelope(canonical(signed()))).toEqual(signed());
    expect(() => verifyEnvelope(signed(), keys)).not.toThrow();
    expect(canonical({ z: 1, a: { b: true, a: "test" } })).toBe(
      '{"a":{"a":"test","b":true},"z":1}',
    );
  });
  it.each([
    (v: Envelope) => ({ ...v, signature: Buffer.alloc(64).toString("base64") }),
    (v: Envelope) => ({ ...v, manifest: { ...v.manifest, version: "9.9.9" } }),
    (v: Envelope) => ({ ...v, keyId: "unknown" }),
  ])("rejects forged signature, mutation and unknown key", (change) => {
    expect(() => verifyEnvelope(change(signed()), keys)).toThrow();
  });
  it("rejects revoked/non Ed25519/duplicate trust keys", () => {
    expect(() =>
      verifyEnvelope(
        signed(),
        parseTrustStore(trustText.replace('"revoked":false', '"revoked":true')),
      ),
    ).toThrow("UNTRUSTED_KEY");
    const parsed = JSON.parse(trustText);
    parsed.keys.push(parsed.keys[0]);
    expect(() => parseTrustStore(JSON.stringify(parsed))).toThrow();
    const rsa = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    parsed.keys = [
      {
        keyId: "ec",
        publicKey: rsa.publicKey.export({ type: "spki", format: "pem" }),
        revoked: false,
      },
    ];
    expect(() => parseTrustStore(JSON.stringify(parsed))).toThrow();
  });
  it.each([
    (s: string) => s.replace('"algorithm":"Ed25519"', '"algorithm":"RSA"'),
    (s: string) =>
      s.replace(
        '"algorithm":"Ed25519"',
        '"algorithm":"RSA","algorithm":"Ed25519"',
      ),
    (s: string) =>
      s.replace('"platform":"linux-arm64"', '"platform":"darwin-arm64"'),
    (s: string) =>
      s.replace('"entrypoint":"app/main.mjs"', '"entrypoint":"../main.mjs"'),
    (s: string) => s + "\n",
    (s: string) =>
      s.replace('"manifest":{', '"manifest":{"url":"http://example.com",'),
  ])("rejects invalid/noncanonical envelope", (change) =>
    expect(() => parseEnvelope(change(canonical(signed())))).toThrow(
      "INVALID_MANIFEST",
    ),
  );
  it.each([
    { nodeRange: ">=22" },
    { nodeRange: ">=23 <24" },
    { otaProtocolRange: "^2" },
    { supervisorRange: "^2" },
    { stateSchemaRange: "^2" },
  ])("rejects incompatible baseline %j", (change) =>
    expect(() =>
      verifyEnvelope(signed({ ...manifest, ...change }), keys),
    ).toThrow("INCOMPATIBLE_RELEASE"),
  );
});
describe("bounded archive and immutable local objects", () => {
  it("checks generated archive/digest/size and concurrent publishing", async () => {
    const root = await directory();
    await expect(verifyArchive(archive)).resolves.toBeUndefined();
    await Promise.all([
      publishArtifact(root, archive),
      publishArtifact(root, archive),
    ]);
    expect(await readArtifact(root, manifest.digest)).toEqual(archive);
    await expect(verifyStoredArtifact(root, manifest)).resolves.toBeUndefined();
    await expect(
      verifyStoredArtifact(root, { ...manifest, size: manifest.size + 1 }),
    ).rejects.toThrow("SIZE_MISMATCH");
    await chmod(join(root, `${manifest.digest}.tar.gz`), 0o600);
    await writeFile(
      join(root, `${manifest.digest}.tar.gz`),
      Buffer.from("corrupt"),
    );
    await expect(readArtifact(root, manifest.digest)).rejects.toThrow(
      "DIGEST_MISMATCH",
    );
  });
  it.each([
    "../main.mjs",
    "/app/main.mjs",
    "app/../main.mjs",
    "app//main.mjs",
    "app/main.sh",
    "app/a/b/c/d/e/f/g/main.mjs",
  ])("rejects unsafe path %s", async (path) => {
    await expect(
      verifyArchive(
        mutatedHeader((b) => {
          b.fill(0, 0, 100);
          b.write(path, 0);
        }),
      ),
    ).rejects.toThrow("INVALID_ARCHIVE");
  });
  it.each(["1", "2", "3", "4", "6", "x", "g", "L"])(
    "rejects links/special/extension header %s",
    async (type) => {
      await expect(
        verifyArchive(
          mutatedHeader((b) => {
            b[156] = type.charCodeAt(0);
          }),
        ),
      ).rejects.toThrow("INVALID_ARCHIVE");
    },
  );
  it("rejects duplicate entries, excessive entries, truncated archive, checksum and expansion bomb", async () => {
    const tar = gunzipSync(archive);
    const entry = tar.subarray(0, 1024);
    await expect(
      verifyArchive(
        gzipSync(Buffer.concat([entry, entry, Buffer.alloc(1024)])),
      ),
    ).rejects.toThrow();
    await expect(
      verifyArchive(gzipSync(tar.subarray(0, 600))),
    ).rejects.toThrow();
    const damaged = Buffer.from(tar);
    damaged[0] = 65;
    await expect(verifyArchive(gzipSync(damaged))).rejects.toThrow();
    await expect(
      verifyArchive(gzipSync(Buffer.alloc(129 * 1024 * 1024))),
    ).rejects.toThrow();
    const many: Buffer[] = [];
    for (let i = 0; i < 513; i++)
      many.push(
        gunzipSync(
          mutatedHeader((b) => {
            b.fill(0, 0, 100);
            b.write(`app/${i}.mjs`, 0);
          }),
        ).subarray(0, 1024),
      );
    await expect(
      verifyArchive(gzipSync(Buffer.concat([...many, Buffer.alloc(1024)]))),
    ).rejects.toThrow();
  });
  it("rejects symlink, directory, oversized file and traversal before reading", async () => {
    const root = await directory();
    const outside = join(root, "outside");
    await writeFile(outside, archive);
    await symlink(outside, join(root, `${manifest.digest}.tar.gz`));
    await expect(readArtifact(root, manifest.digest)).rejects.toThrow(
      "ARTIFACT_UNAVAILABLE",
    );
    await expect(readArtifact(root, "../outside")).rejects.toThrow(
      "INVALID_DIGEST",
    );
    await expect(readArtifact(root, "0".repeat(64))).rejects.toThrow(
      "ARTIFACT_NOT_FOUND",
    );
    const large = await open(join(root, `${"1".repeat(64)}.tar.gz`), "wx");
    try {
      await large.truncate(32 * 1024 * 1024 + 1);
    } finally {
      await large.close();
    }
    await expect(readArtifact(root, "1".repeat(64))).rejects.toThrow(
      "INVALID_SIZE",
    );
    await mkdir(join(root, `${"2".repeat(64)}.tar.gz`));
    await expect(readArtifact(root, "2".repeat(64))).rejects.toThrow(
      "INVALID_SIZE",
    );
  });
  it("serves exact immutable bytes locally, never arbitrary paths/URLs or writes", async () => {
    const root = await directory();
    await publishArtifact(root, archive);
    const server = createArtifactServer(root);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${base}/objects/${manifest.digest}.tar.gz`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(archive);
      expect(
        (
          await fetch(`${base}/objects/${manifest.digest}.tar.gz`, {
            method: "HEAD",
          })
        ).status,
      ).toBe(200);
      for (const path of [
        "/../private.pem",
        "/objects/%2e%2e/private.pem",
        `/objects/${manifest.digest}.tar.gz?url=http://example.com`,
        "/http://example.com",
      ])
        expect((await fetch(base + path)).status).toBe(404);
      expect(
        (
          await fetch(`${base}/objects/${manifest.digest}.tar.gz`, {
            method: "PUT",
            body: "replace",
          })
        ).status,
      ).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
