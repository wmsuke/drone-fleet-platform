import { createGunzip, gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { MAX_ARCHIVE_BYTES, ReleaseError } from "./manifest.js";

const MAX_EXPANDED = 128 * 1024 * 1024;
// 狭いPOSIX ustar subsetだけを受け付ける。展開・コード実行は行わない。
export async function verifyArchive(
  bytes: Uint8Array,
  visitor?: {
    start(path: string, directory: boolean): Promise<void>;
    data(bytes: Uint8Array): Promise<void>;
    end(): Promise<void>;
  },
) {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ReleaseError("INVALID_SIZE");
  const stream = Readable.from([bytes]).pipe(createGunzip());
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let remaining = 0;
  let contentRemaining = 0;
  let total = 0;
  let entries = 0;
  let zeros = 0;
  let entrypoint = false;
  const paths = new Set<string>();
  const files = new Set<string>();
  const fail = () => {
    throw new ReleaseError("INVALID_ARCHIVE");
  };
  const field = (b: Buffer, start: number, length: number) => {
    const part = b.subarray(start, start + length);
    const nul = part.indexOf(0);
    const content = nul < 0 ? part : part.subarray(0, nul);
    if (nul >= 0 && part.subarray(nul).some((v) => v !== 0)) fail();
    if (content.some((v) => v < 32 || v > 126)) fail();
    return content.toString("ascii");
  };
  const octal = (b: Buffer, start: number, length: number) => {
    const value = b.subarray(start, start + length).toString("ascii");
    if (!/^[0-7]+[\0 ]*$/.test(value)) fail();
    const n = parseInt(value, 8);
    if (!Number.isSafeInteger(n)) fail();
    return n;
  };
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > MAX_EXPANDED) fail();
      pending = Buffer.concat([pending, buffer]);
      while (pending.length >= 512) {
        const block = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (remaining > 0) {
          await visitor?.data(
            block.subarray(0, Math.min(contentRemaining, 512)),
          );
          contentRemaining -= Math.min(contentRemaining, 512);
          remaining--;
          if (remaining === 0) await visitor?.end();
          continue;
        }
        if (block.every((v) => v === 0)) {
          zeros++;
          continue;
        }
        if (zeros > 0 || ++entries > 512) fail();
        if (block.subarray(257, 265).toString("ascii") !== "ustar\0" + "00")
          fail();
        const checksum = octal(block, 148, 8);
        let sum = 0;
        for (let i = 0; i < 512; i++)
          sum += i >= 148 && i < 156 ? 32 : block[i]!;
        if (sum !== checksum) fail();
        const name = field(block, 0, 100);
        const prefix = field(block, 345, 155);
        const path = prefix ? `${prefix}/${name}` : name;
        const type = block[156];
        const isDirectory = type === 53;
        const normalized =
          isDirectory && path.endsWith("/") ? path.slice(0, -1) : path;
        const parts = normalized.split("/");
        if (
          !normalized ||
          parts.length > 8 ||
          parts.some(
            (p) =>
              !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p) ||
              p === "." ||
              p === "..",
          ) ||
          paths.has(normalized)
        )
          fail();
        paths.add(normalized);
        for (let i = 1; i < parts.length; i++) {
          if (files.has(parts.slice(0, i).join("/"))) fail();
        }
        if (!isDirectory) {
          if ([...paths].some((p) => p.startsWith(normalized + "/"))) fail();
          files.add(normalized);
        }
        if (
          (type !== 0 && type !== 48 && !isDirectory) ||
          field(block, 157, 100) !== ""
        )
          fail();
        // app配下のbundle/JSONとdirectoryだけ。hookやnative addonは入れない。
        if (
          !isDirectory &&
          (!normalized.startsWith("app/") ||
            !/\.(mjs|json)$/.test(normalized) ||
            parts.at(-1) === "package.json")
        )
          fail();
        const size = octal(block, 124, 12);
        const mode = octal(block, 100, 8);
        if (
          size > MAX_EXPANDED ||
          (isDirectory && size !== 0) ||
          (mode & 0o7000) !== 0
        )
          fail();
        if (normalized === "app/main.mjs" && !isDirectory && size > 0)
          entrypoint = true;
        remaining = Math.ceil(size / 512);
        contentRemaining = size;
        await visitor?.start(normalized, isDirectory);
        if (remaining === 0) await visitor?.end();
      }
    }
    if (pending.length !== 0 || remaining !== 0 || zeros < 2 || !entrypoint)
      fail();
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    fail();
  } finally {
    stream.destroy();
  }
}

export function packBundle(bundle: Uint8Array): Buffer {
  if (bundle.length === 0 || bundle.length > MAX_EXPANDED - 1536)
    throw new ReleaseError("INVALID_ARCHIVE");
  const header = Buffer.alloc(512);
  header.write("app/main.mjs", 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${bundle.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0" + "00", 257);
  const checksum = header.reduce((sum, v) => sum + v, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(
    Buffer.concat([
      header,
      bundle,
      Buffer.alloc(((512 - (bundle.length % 512)) % 512) + 1024),
    ]),
  );
}
