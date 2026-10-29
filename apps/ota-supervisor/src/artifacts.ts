import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns";
import { isIP } from "node:net";
import {
  realpath,
  mkdir,
  open,
  readFile,
  rename,
  chmod,
  statfs,
  readdir,
  lstat,
  rm,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  canonical,
  parseEnvelope,
  parseTrustStore,
  verifyEnvelope,
  verifyArchive,
  digestOf,
  ReleaseError,
  type Envelope,
} from "@drone-fleet/releases";
import semver from "semver";

export async function protectTrustFile(path: string, data: string) {
  if (
    (await realpath(path)) !== path ||
    path === data ||
    path.startsWith(data + "/")
  )
    throw new Error("unprotected trust file");
  const file = await lstat(path);
  if (!file.isFile() || file.uid === 10001 || (file.mode & 0o022) !== 0)
    throw new Error("unprotected trust file");
  let directory = dirname(path);
  while (directory !== "/") {
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.uid === 10001 ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    )
      throw new Error("unprotected trust directory");
    directory = dirname(directory);
  }
}

export interface Source {
  origin: string;
  allowedCidrs: string[];
  localHttp: boolean;
}
export function permittedAddress(address: string, cidrs: string[]) {
  if (address === "::1") return cidrs.includes("::1/128");
  if (isIP(address) !== 4) return false;
  const n = (ip: string) =>
    ip.split(".").reduce((a, v) => (a * 256 + Number(v)) >>> 0, 0);
  return cidrs.some((cidr) => {
    const [base, bits] = cidr.split("/");
    const p = Number(bits);
    if (!base || isIP(base) !== 4 || !Number.isInteger(p) || p < 8 || p > 32)
      return false;
    const mask = (0xffffffff << (32 - p)) >>> 0;
    return (n(base) & mask) === (n(address) & mask);
  });
}
export function validateSource(source: Source) {
  const url = new URL(source.origin);
  if (
    url.origin !== source.origin ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("invalid artifact origin");
  if (url.protocol === "http:" && !source.localHttp)
    throw new Error("HTTPS is required");
  if (!source.allowedCidrs.length)
    throw new Error("address allowlist required");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    isIP(host) &&
    (!permittedAddress(host, source.allowedCidrs) ||
      (url.protocol === "http:" &&
        !(
          /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
          host === "::1"
        )))
  )
    throw new Error("address denied");
  return url;
}
export async function fetchBytes(
  source: Source,
  path: string,
  max: number,
  signal: AbortSignal,
  onBytes: (n: number) => void = () => {},
) {
  const origin = validateSource(source);
  if (
    !/^\/(?:releases\/[0-9a-f-]{36}|objects\/[0-9a-f]{64}\.tar\.gz)$/.test(path)
  )
    throw new Error("invalid artifact path");
  return new Promise<Buffer>((resolve, reject) => {
    const request = (origin.protocol === "https:" ? httpsRequest : httpRequest)(
      new URL(path, origin),
      {
        signal,
        agent: false,
        lookup(host, options, callback) {
          lookup(host, { all: true }, (error, addresses) => {
            if (error) {
              callback(error, [], 0);
              return;
            }
            if (
              !addresses.length ||
              addresses.some(
                (entry) =>
                  !permittedAddress(entry.address, source.allowedCidrs) ||
                  (origin.protocol === "http:" &&
                    !(
                      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
                        entry.address,
                      ) || entry.address === "::1"
                    )),
              )
            ) {
              callback(new Error("address denied"), [], 0);
              return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          reject(
            new ReleaseError(
              response.statusCode === 429 || (response.statusCode ?? 0) >= 500
                ? "DOWNLOAD_FAILED"
                : "DOWNLOAD_REJECTED",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          try {
            onBytes(chunk.length);
            size += chunk.length;
            if (size > max) throw new ReleaseError("SIZE_MISMATCH");
            chunks.push(chunk);
          } catch (error) {
            reject(error);
            request.destroy(error as Error);
          }
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      },
    );
    const connectTimer = setTimeout(
      () => request.destroy(new Error("connect timeout")),
      10000,
    );
    request.once("socket", (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      socket.once(
        origin.protocol === "https:" ? "secureConnect" : "connect",
        () => clearTimeout(connectTimer),
      );
    });
    request.setTimeout(10000, () => request.destroy(new Error("idle timeout")));
    request.once("error", (error: Error & { code?: string }) =>
      reject(
        error instanceof ReleaseError
          ? error
          : new ReleaseError(
              [
                "ECONNRESET",
                "ECONNREFUSED",
                "ETIMEDOUT",
                "EAI_AGAIN",
                "ABORT_ERR",
              ].includes(error.code ?? "") || error.message.includes("timeout")
                ? "DOWNLOAD_FAILED"
                : "DOWNLOAD_REJECTED",
            ),
      ),
    );
    request.once("close", () => clearTimeout(connectTimer));
    request.end();
  });
}
export async function syncDirectory(path: string) {
  const dir = await open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function atomicWrite(path: string, bytes: string) {
  const temporary = `${path}.partial`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
export async function verifyCompatible(envelope: Envelope, trustPath: string) {
  verifyEnvelope(envelope, parseTrustStore(await readFile(trustPath, "utf8")));
  const m = envelope.manifest;
  if (
    process.platform !== "linux" ||
    m.platform !== `linux-${process.arch}` ||
    m.application !== "simulator" ||
    !semver.satisfies(process.versions.node, m.nodeRange) ||
    !semver.satisfies("1.0.0", m.supervisorRange) ||
    !semver.satisfies("1.0.0", m.otaProtocolRange) ||
    !semver.satisfies("1.0.0", m.stateSchemaRange)
  )
    throw new ReleaseError("INCOMPATIBLE_RELEASE");
}
export async function usedBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new ReleaseError("INVALID_ARCHIVE");
    total += stat.isDirectory() ? await usedBytes(path) : stat.size;
  }
  return total;
}
export async function checkCapacity(root: string, archiveSize: number) {
  const required = archiveSize + 128 * 1024 * 1024;
  const disk = await statfs(root);
  if (
    (await usedBytes(root)) + required > 512 * 1024 * 1024 ||
    disk.bavail * disk.bsize < required + 64 * 1024 * 1024
  )
    throw new ReleaseError("CAPACITY_EXCEEDED");
}
export async function stageArtifact(
  root: string,
  envelope: Envelope,
  bytes: Buffer,
) {
  const m = envelope.manifest;
  if (bytes.length !== m.size) throw new ReleaseError("SIZE_MISMATCH");
  if (digestOf(bytes) !== m.digest) throw new ReleaseError("DIGEST_MISMATCH");
  await verifyArchive(bytes);
  const target = join(root, "releases", m.digest);
  try {
    const saved = parseEnvelope(
      await readFile(join(target, "manifest.json"), "utf8"),
    );
    if (canonical(saved) !== canonical(envelope))
      throw new ReleaseError("RELEASE_CONFLICT");
    await verifyInstalled(root, saved);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = join(root, "staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await verifyArchive(bytes, {
      async start(path, directory) {
        const destination = join(staging, path);
        await mkdir(dirname(destination), { recursive: true });
        if (directory) await mkdir(destination, { recursive: true });
        else file = await open(destination, "wx", 0o444);
      },
      async data(chunk) {
        await file?.writeFile(chunk);
      },
      async end() {
        if (file) {
          await file.sync();
          await file.close();
          file = undefined;
        }
      },
    });
    await atomicWrite(join(staging, "manifest.json"), canonical(envelope));
    const archive = await open(join(staging, "archive.tar.gz"), "wx", 0o400);
    try {
      await archive.writeFile(bytes);
      await archive.sync();
    } finally {
      await archive.close();
    }
    await seal(staging);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await rename(staging, target);
    await syncDirectory(dirname(target));
  } finally {
    await file?.close();
  }
}
async function seal(root: string) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) await seal(path);
    else
      await chmod(
        path,
        item.name === "archive.tar.gz" || item.name === "manifest.json"
          ? 0o400
          : 0o444,
      );
  }
  await chmod(root, 0o755);
  await syncDirectory(root);
}
export async function verifyInstalled(root: string, envelope: Envelope) {
  const dir = join(root, "releases", envelope.manifest.digest);
  const bytes = await readFile(join(dir, "archive.tar.gz"));
  if (
    digestOf(bytes) !== envelope.manifest.digest ||
    bytes.length !== envelope.manifest.size
  )
    throw new ReleaseError("DIGEST_MISMATCH");
  // 展開済みentryも元archiveと照合する。root管理者の変更を検出して実行しない。
  let file: Buffer[] = [];
  let path = "";
  await verifyArchive(bytes, {
    async start(name, directory) {
      path = directory ? "" : name;
      file = [];
    },
    async data(chunk) {
      if (path) file.push(Buffer.from(chunk));
    },
    async end() {
      if (path && !Buffer.concat(file).equals(await readFile(join(dir, path))))
        throw new ReleaseError("DIGEST_MISMATCH");
    },
  });
  return dir;
}
