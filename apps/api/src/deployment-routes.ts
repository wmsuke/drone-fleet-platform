import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditContext, OtaControlError } from "@drone-fleet/database";
import { deploymentRequestSchema } from "./deployment-schema.js";
import { idempotencyKeySchema } from "./fleet-operation-schema.js";
import {
  DeploymentError,
  type DeploymentRepository,
} from "./deployment-repository.js";

export function registerDeploymentRoutes(
  app: FastifyInstance,
  repository: DeploymentRepository,
) {
  app.post(
    "/deployments/:deploymentId/targets/:targetId/recover",
    { bodyLimit: 2048 },
    async (request, reply) => {
      const params = z
        .object({
          deploymentId: z.uuid().transform((v) => v.toLowerCase()),
          targetId: z.uuid().transform((v) => v.toLowerCase()),
        })
        .safeParse(request.params);
      const body = z
        .object({
          kind: z.enum(["RETRY", "ROLLBACK"]),
          reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
        })
        .strict()
        .safeParse(request.body);
      const key = idempotencyKeySchema.safeParse(
        request.headers["idempotency-key"],
      );
      if (!params.success || !body.success || !key.success)
        return reply.code(400).send({ error: "INVALID_RECOVERY_REQUEST" });
      try {
        const result = await repository.recover(
          params.data.deploymentId,
          params.data.targetId,
          key.data,
          body.data.kind,
          body.data.reason,
        );
        return reply
          .code(result.status === "UNAVAILABLE" ? 409 : 202)
          .send(result);
      } catch (error) {
        if (error instanceof OtaControlError)
          return reply.code(error.status).send({ error: error.reason });
        return reply.code(503).send({ error: "RECOVERY_UNAVAILABLE" });
      }
    },
  );
  for (const action of ["approve", "stop", "resume"] as const) {
    app.post(
      `/deployments/:deploymentId/${action === "approve" ? "stages/:stageId/approve" : action}`,
      { bodyLimit: 2048 },
      async (request, reply) => {
        const params = z
          .object({
            deploymentId: z.uuid().transform((v) => v.toLowerCase()),
            ...(action === "approve"
              ? { stageId: z.uuid().transform((v) => v.toLowerCase()) }
              : {}),
          })
          .safeParse(request.params);
        const body = z
          .object({ reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) })
          .strict()
          .safeParse(request.body);
        const key = idempotencyKeySchema.safeParse(
          request.headers["idempotency-key"],
        );
        if (!params.success || !body.success || !key.success)
          return reply.code(400).send({ error: "INVALID_DEPLOYMENT_ACTION" });
        try {
          return reply
            .code(202)
            .send(
              await repository.act(
                params.data.deploymentId,
                action,
                key.data,
                body.data.reason,
                "stageId" in params.data
                  ? (params.data.stageId as string)
                  : undefined,
              ),
            );
        } catch (error) {
          if (error instanceof OtaControlError) {
            const context = auditContext.getStore();
            if (context) context.rejectionReason = error.reason;
            return reply.code(error.status).send({ error: error.reason });
          }
          return reply.code(503).send({ error: "DEPLOYMENT_UNAVAILABLE" });
        }
      },
    );
  }
  app.get("/deployments", async (request, reply) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        before: z.iso.datetime({ precision: 3 }).optional(),
      })
      .strict()
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "INVALID_DEPLOYMENT_QUERY" });
    return repository.list(query.data.limit, query.data.before);
  });
  app.get("/deployments/:deploymentId", async (request, reply) => {
    const params = z
      .object({ deploymentId: z.uuid().transform((v) => v.toLowerCase()) })
      .safeParse(request.params);
    const query = z
      .object({
        eventLimit: z.coerce.number().int().min(1).max(100).default(20),
        stageId: z
          .uuid()
          .transform((v) => v.toLowerCase())
          .optional(),
      })
      .strict()
      .safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ error: "INVALID_DEPLOYMENT_QUERY" });
    const row = await repository.find(
      params.data.deploymentId,
      query.data.eventLimit,
      query.data.stageId,
    );
    return row ?? reply.code(404).send({ error: "DEPLOYMENT_NOT_FOUND" });
  });
  app.post("/deployments", { bodyLimit: 32768 }, async (request, reply) => {
    const body = deploymentRequestSchema.safeParse(request.body);
    const key = idempotencyKeySchema.safeParse(
      request.headers["idempotency-key"],
    );
    if (!body.success || !key.success)
      return reply.code(400).send({ error: "INVALID_DEPLOYMENT_REQUEST" });
    try {
      return reply.code(202).send(await repository.create(body.data, key.data));
    } catch (error) {
      if (error instanceof DeploymentError) {
        const context = auditContext.getStore();
        if (context) context.rejectionReason = error.reason;
        if (error.status === 429) reply.header("Retry-After", "1");
        return reply.code(error.status).send({ error: error.reason });
      }
      // snapshot・配信物・file path・要求本文をログや応答へ出さない。
      return reply.code(503).send({ error: "DEPLOYMENT_UNAVAILABLE" });
    }
  });
}
