import type { FastifyInstance } from "fastify";
import { auditContext } from "@drone-fleet/database";
import { z } from "zod";
import {
  FleetOperationError,
  type FleetOperationRepository,
} from "./fleet-operation-repository.js";
import {
  fleetOperationRequestSchema,
  fleetOperationResponseSchema,
  idempotencyKeySchema,
  operationListQuerySchema,
  operationTargetQuerySchema,
  operationListResponseSchema,
  operationDetailResponseSchema,
} from "./fleet-operation-schema.js";
export function registerFleetOperationRoutes(
  app: FastifyInstance,
  repository: FleetOperationRepository,
) {
  app.get("/fleet-operations", async (request, reply) => {
    const query = operationListQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "一覧条件が不正です" });
    return operationListResponseSchema.parse(await repository.list(query.data));
  });
  app.get("/fleet-operations/:operationId", async (request, reply) => {
    const params = z
      .object({ operationId: z.uuid().transform((id) => id.toLowerCase()) })
      .safeParse(request.params);
    const query = operationTargetQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ error: "操作IDまたは対象条件が不正です" });
    const operation = await repository.find(
      params.data.operationId,
      query.data,
    );
    if (!operation)
      return reply.code(404).send({ error: "operationが見つかりません" });
    return operationDetailResponseSchema.parse(operation);
  });
  app.post("/fleet-operations", async (request, reply) => {
    const body = fleetOperationRequestSchema.safeParse(request.body);
    const key = idempotencyKeySchema.safeParse(
      request.headers["idempotency-key"],
    );
    if (!body.success || !key.success)
      return reply
        .code(400)
        .send({ error: "groupId、type、Idempotency-Keyの入力が不正です" });
    try {
      return reply
        .code(202)
        .send(
          fleetOperationResponseSchema.parse(
            await repository.create(body.data, key.data),
          ),
        );
    } catch (error) {
      if (error instanceof FleetOperationError) {
        const context = auditContext.getStore();
        if (context) context.rejectionReason = error.reason;
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });
}
