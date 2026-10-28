import type { FastifyInstance } from "fastify";
import { auditContext } from "@drone-fleet/database";
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
