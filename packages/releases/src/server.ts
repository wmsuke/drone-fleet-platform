import { createServer } from "node:http";
import { artifactRoot, readArtifact } from "./store.js";
import { ReleaseError } from "./manifest.js";

export function createArtifactServer(root: string) {
  // 同時downloadを制限し32 MiBのbufferが無制限に増えるのを防ぐ。
  let active = 0;
  return createServer(
    { requestTimeout: 10000, headersTimeout: 10000 },
    (request, response) => {
      const match = /^\/objects\/([0-9a-f]{64})\.tar\.gz$/.exec(
        request.url ?? "",
      );
      if (!match || !["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(404).end();
        return;
      }
      if (active >= 2) {
        response.writeHead(503).end();
        return;
      }
      active++;
      let readDone = false;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          active--;
        }
      };
      response.once("close", () => {
        if (readDone) release();
      });
      response.setTimeout(10000, () => response.destroy());
      void readArtifact(root, match[1]!)
        .then((bytes) => {
          response.writeHead(200, {
            "Content-Type": "application/gzip",
            "Content-Length": bytes.length,
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            ETag: `"${match[1]}"`,
          });
          response.end(request.method === "HEAD" ? undefined : bytes);
        })
        .catch((error: unknown) => {
          response
            .writeHead(
              error instanceof ReleaseError &&
                error.reason === "ARTIFACT_NOT_FOUND"
                ? 404
                : 422,
            )
            .end();
        })
        .finally(() => {
          readDone = true;
          if (response.destroyed || response.writableFinished) release();
        });
    },
  );
}
if (process.argv[1]?.endsWith("/server.js")) {
  const root = await artifactRoot(process.env.OTA_RELEASE_DIR ?? "/artifacts");
  const server = createArtifactServer(root);
  server.listen(8080, "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => server.close());
}
