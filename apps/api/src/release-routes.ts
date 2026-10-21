import { readFile } from "node:fs/promises";
import {
  artifactRoot,
  parseEnvelope,
  parseTrustStore,
  verifyEnvelope,
  verifyStoredArtifact,
  ReleaseError,
} from "@drone-fleet/releases";
import { auditContext } from "@drone-fleet/database";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ReleaseRepository } from "./release-repository.js";

export interface ReleaseOptions {
  repository: ReleaseRepository;
  directory: string;
  trustStorePath: string;
}
export function registerReleaseRoutes(
  app: FastifyInstance,
  options: ReleaseOptions,
) {
  let active = 0;
  void app.register(async (routes) => {
    routes.removeContentTypeParser("application/json");
    routes.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: 16384 },
      (_request, body, done) => done(null, body),
    );
    const present = (row: Awaited<ReturnType<ReleaseRepository["find"]>>) => ({
      ...row,
      verifiedAt: row.verifiedAt.toISOString(),
      artifactPath: `/objects/${row.digest}.tar.gz`,
    });
    routes.post<{ Body: string }>(
      "/releases",
      { bodyLimit: 16384 },
      async (request, reply) => {
        if (active >= 2) return reply.code(503).send({ error: "RELEASE_BUSY" });
        active++;
        try {
          const envelope = parseEnvelope(request.body);
          // 毎回読み直すためtrust storeの失効を登録時に反映する。
          const keys = parseTrustStore(
            await readFile(options.trustStorePath, "utf8"),
          );
          verifyEnvelope(envelope, keys);
          const root = await artifactRoot(options.directory);
          await verifyStoredArtifact(root, envelope.manifest);
          const { release, created } =
            await options.repository.register(envelope);
          return reply.code(created ? 201 : 200).send(present(release));
        } catch (error) {
          if (error instanceof ReleaseError) {
            const context = auditContext.getStore();
            if (context) context.rejectionReason = error.reason;
            return reply.code(error.status).send({ error: error.reason });
          }
          // 鍵・file path・入力本文をエラー応答/ログへ出さない。
          return reply.code(503).send({ error: "RELEASE_UNAVAILABLE" });
        } finally {
          active--;
        }
      },
    );
    routes.get("/releases", async () => ({
      items: (await options.repository.list()).map(present),
      limit: 100,
    }));
    routes.get<{ Params: { releaseId: string } }>(
      "/releases/:releaseId",
      async (request, reply) => {
        const id = z.uuid().safeParse(request.params.releaseId);
        if (!id.success)
          return reply.code(400).send({ error: "INVALID_RELEASE_ID" });
        try {
          return present(await options.repository.find(id.data.toLowerCase()));
        } catch (error) {
          if (error instanceof ReleaseError)
            return reply.code(error.status).send({ error: error.reason });
          throw error;
        }
      },
    );
  });
}
