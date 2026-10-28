import { createPublicKey, verify, type KeyObject } from "node:crypto";
import semver from "semver";
import { z } from "zod";

export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export class ReleaseError extends Error {
  constructor(
    public readonly reason: string,
    public readonly status = 400,
  ) {
    super(reason);
  }
}
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const version = z
  .string()
  .max(64)
  .refine((v) => semver.valid(v) === v);
const range = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/)
  .refine((v) => semver.validRange(v) !== null);
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseId: z.uuid().refine((v) => v === v.toLowerCase()),
    application: z.enum(["simulator", "edge-agent"]),
    version,
    buildId: identifier,
    platform: z.enum(["linux-arm64", "linux-x64"]),
    nodeRange: range,
    otaProtocolRange: range,
    supervisorRange: range,
    stateSchemaRange: range,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().min(1).max(MAX_ARCHIVE_BYTES),
    entrypoint: z.literal("app/main.mjs"),
    healthContractVersion: z.literal("ota-health-v1"),
    rollbackCompatible: z.boolean(),
  })
  .strict();
export const envelopeSchema = z
  .object({
    manifest: manifestSchema,
    keyId: identifier,
    algorithm: z.literal("Ed25519"),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type TrustStore = ReadonlyMap<string, KeyObject>;

// このschemaはASCIIのkey/string、boolean、安全な整数のみ。RFC 8785の
// ECMAScript直列化とUTF-16 key順序で正規化できる（任意JSONの実装ではない）。
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new ReleaseError("INVALID_MANIFEST");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
    .join(",")}}`;
}
export function parseEnvelope(text: unknown): Envelope {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16384)
    throw new ReleaseError("INVALID_MANIFEST");
  try {
    const input: unknown = JSON.parse(text);
    const result = envelopeSchema.parse(input);
    // canonicalなenvelopeだけを受理。重複key・空白・escapeによる別解釈も拒否する。
    if (canonical(result) !== text) throw new Error("non canonical");
    return result;
  } catch {
    throw new ReleaseError("INVALID_MANIFEST");
  }
}
export function parseTrustStore(text: string): TrustStore {
  const input = z
    .object({
      keys: z
        .array(
          z
            .object({
              keyId: identifier,
              publicKey: z
                .string()
                .max(4096)
                .regex(
                  /^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/,
                ),
              revoked: z.boolean(),
            })
            .strict(),
        )
        .max(32),
    })
    .strict()
    .parse(JSON.parse(text));
  const result = new Map<string, KeyObject>();
  const seen = new Set<string>();
  for (const item of input.keys) {
    if (seen.has(item.keyId))
      throw new Error("trust store keyIdが重複しています");
    seen.add(item.keyId);
    const key = createPublicKey(item.publicKey);
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("Ed25519公開鍵が必要です");
    if (!item.revoked) result.set(item.keyId, key);
  }
  return result;
}
export function verifyEnvelope(envelope: Envelope, keys: TrustStore) {
  const key = keys.get(envelope.keyId);
  if (!key) throw new ReleaseError("UNTRUSTED_KEY");
  const signature = Buffer.from(envelope.signature, "base64");
  if (
    signature.toString("base64") !== envelope.signature ||
    !verify(null, Buffer.from(canonical(envelope.manifest)), key, signature)
  )
    throw new ReleaseError("INVALID_SIGNATURE");
  const m = envelope.manifest;
  // 登録時はPhase 5のbaseline能力との互換を検証。端末固有の照合は#168。
  if (
    !semver.subset(m.nodeRange, ">=22.13.0 <23") ||
    !semver.satisfies("22.13.0", m.nodeRange) ||
    !semver.satisfies("1.0.0", m.otaProtocolRange) ||
    !semver.satisfies("1.0.0", m.supervisorRange) ||
    !semver.satisfies("1.0.0", m.stateSchemaRange)
  )
    throw new ReleaseError("INCOMPATIBLE_RELEASE");
}

export function compatibleUpgrade(
  manifest: Manifest,
  current: {
    application: string;
    platform: string;
    version: string;
    nodeVersion: string;
    otaProtocolVersion: string;
    supervisorVersion: string;
    stateSchemaVersion: string;
    healthContractVersion: string;
  },
) {
  return (
    manifest.application === current.application &&
    manifest.platform === current.platform &&
    manifest.healthContractVersion === current.healthContractVersion &&
    semver.valid(current.version) !== null &&
    semver.gt(manifest.version, current.version) &&
    semver.satisfies(current.nodeVersion, manifest.nodeRange) &&
    semver.satisfies(current.otaProtocolVersion, manifest.otaProtocolRange) &&
    semver.satisfies(current.supervisorVersion, manifest.supervisorRange) &&
    semver.satisfies(current.stateSchemaVersion, manifest.stateSchemaRange)
  );
}
