import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  canonical,
  manifestSchema,
  envelopeSchema,
  parseTrustStore,
  verifyEnvelope,
} from "./manifest.js";
import { packBundle } from "./archive.js";
import { digestOf, publishArtifact } from "./store.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "keygen" && args.length === 2) {
    const root = resolve(args[0]!);
    const trust = resolve(args[1]!);
    if (trust === root || root.startsWith(trust + "/"))
      throw new Error("秘密鍵と公開鍵は別領域へ保存してください");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(trust, { recursive: true });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await writeFile(
      join(root, "private.pem"),
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(trust, "trust-store.json"),
      JSON.stringify({
        keys: [
          {
            keyId: "local-demo",
            publicKey: publicKey.export({ type: "spki", format: "pem" }),
            revoked: false,
          },
        ],
      }),
      { flag: "wx" },
    );
    return;
  }
  if (command === "pack" && args.length === 5) {
    const [config, bundlePath, privatePath, store, output] = args as [
      string,
      string,
      string,
      string,
      string,
    ];
    const archive = packBundle(await readFile(bundlePath));
    const manifest = manifestSchema.parse({
      ...JSON.parse(await readFile(config, "utf8")),
      digest: digestOf(archive),
      size: archive.length,
    });
    const key = createPrivateKey(await readFile(privatePath));
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("Ed25519秘密鍵が必要です");
    const envelope = envelopeSchema.parse({
      manifest,
      keyId: process.env.OTA_SIGNING_KEY_ID ?? "local-demo",
      algorithm: "Ed25519",
      signature: sign(null, Buffer.from(canonical(manifest)), key).toString(
        "base64",
      ),
    });
    const publicKey = generatePublicTrust(key, envelope.keyId);
    verifyEnvelope(envelope, publicKey);
    await publishArtifact(store, archive);
    await writeFile(output, canonical(envelope), { flag: "wx" });
    console.info(
      JSON.stringify({
        releaseId: manifest.releaseId,
        digest: manifest.digest,
        size: manifest.size,
      }),
    );
    return;
  }
  throw new Error(
    "使い方: keygen <秘密鍵directory> <公開鍵directory> | pack <manifest設定.json> <bundle.mjs> <private.pem> <object領域> <出力envelope.json>",
  );
}
import { createPublicKey, type KeyObject } from "node:crypto";
function generatePublicTrust(key: KeyObject, keyId: string) {
  return parseTrustStore(
    JSON.stringify({
      keys: [
        {
          keyId,
          publicKey: createPublicKey(key).export({
            type: "spki",
            format: "pem",
          }),
          revoked: false,
        },
      ],
    }),
  );
}
void main().catch(() => {
  console.error(
    "release作成に失敗しました。入力形式・鍵・保存先を確認してください",
  );
  process.exitCode = 1;
});
