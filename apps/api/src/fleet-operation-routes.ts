import type { FastifyInstance } from "fastify";
import {
  FleetOperationError,
  type FleetOperationRepository,
} from "./fleet-operation-repository.js";
import {
  fleetOperationRequestSchema,
  fleetOperationResponseSchema,
  idempotencyKeySchema,
} from "./fleet-operation-schema.js";
export function registerFleetOperationRoutes(
  app: FastifyInstance,
  repository: FleetOperationRepository,
) {
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
      if (error instanceof FleetOperationError)
        return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
}
