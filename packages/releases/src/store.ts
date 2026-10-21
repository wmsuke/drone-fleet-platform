import { constants } from "node:fs";
import { open, realpath, lstat, mkdir, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MAX_ARCHIVE_BYTES, ReleaseError, type Manifest } from "./manifest.js";
import { verifyArchive } from "./archive.js";

export const digestOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export async function artifactRoot(directory: string) {
  const root = resolve(directory);
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
    throw new Error("配信領域にsymlinkは使えません");
  return root;
}
export async function readArtifact(root: string, digest: string) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new ReleaseError("INVALID_DIGEST");
  let file;
  try {
    file = await open(
      join(root, `${digest}.tar.gz`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES)
      throw new ReleaseError("INVALID_SIZE");
    // readFileだと検査後に伸びたfileを無制限に読めるため固定長で読む。
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw new ReleaseError("INVALID_SIZE");
      offset += bytesRead;
    }
    if ((await file.stat()).size !== stat.size)
      throw new ReleaseError("INVALID_SIZE");
    if (digestOf(bytes) !== digest) throw new ReleaseError("DIGEST_MISMATCH");
    return bytes;
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ReleaseError("ARTIFACT_NOT_FOUND", 422);
    throw new ReleaseError("ARTIFACT_UNAVAILABLE", 422);
  } finally {
    await file?.close();
  }
}
export async function verifyStoredArtifact(root: string, manifest: Manifest) {
  const bytes = await readArtifact(root, manifest.digest);
  if (bytes.length !== manifest.size) throw new ReleaseError("SIZE_MISMATCH");
  await verifyArchive(bytes);
}
// 公開先の上書きはlinkで原子的に拒否する。writerはこのCLIだけに限定する。
export async function publishArtifact(directory: string, bytes: Buffer) {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ReleaseError("INVALID_SIZE");
  await verifyArchive(bytes);
  await mkdir(directory, { recursive: true });
  const root = await artifactRoot(directory);
  const digest = digestOf(bytes);
  const temporary = join(root, `.${randomUUID()}.partial`);
  const file = await open(temporary, "wx", 0o444);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    try {
      await link(temporary, join(root, `${digest}.tar.gz`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readArtifact(root, digest)).equals(bytes))
        throw new ReleaseError("DIGEST_MISMATCH");
    }
    const dir = await open(root, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await file.close();
    await unlink(temporary);
  }
  return digest;
}
