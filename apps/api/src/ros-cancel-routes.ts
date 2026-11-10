import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  RosCancelError,
  auditContext,
  type BridgeRepository,
} from "@drone-fleet/database";
import { deviceIdSchema } from "./schema.js";
import { idempotencyKeySchema } from "./fleet-operation-schema.js";
const params = z
  .object({
    deviceId: deviceIdSchema,
    commandId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
  })
  .strict();
const body = z
  .object({ reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) })
  .strict();
export function registerRosCancelRoutes(
  app: FastifyInstance,
  repo: BridgeRepository["cancellations"],
) {
  app.post(
    "/devices/:deviceId/commands/:commandId/cancel",
    async (request, reply) => {
      const p = params.safeParse(request.params),
        b = body.safeParse(request.body),
        key = idempotencyKeySchema.safeParse(
          request.headers["idempotency-key"],
        );
      if (!p.success || !b.success || !key.success)
        return reply.code(400).send({ error: "INVALID_CANCEL_REQUEST" });
      try {
        const result = await repo.create(
          p.data.deviceId,
          p.data.commandId,
          key.data,
          b.data.reason,
        );
        return reply.code(202).send({
          ...result,
          state: await repo.get(p.data.deviceId, p.data.commandId),
        });
      } catch (error) {
        if (!(error instanceof RosCancelError)) throw error;
        const context = auditContext.getStore();
        if (context) context.rejectionReason = error.message;
        return reply.code(error.status).send({ error: error.message });
      }
    },
  );
  app.get(
    "/devices/:deviceId/commands/:commandId/cancel",
    async (request, reply) => {
      const p = params.safeParse(request.params);
      if (!p.success)
        return reply.code(400).send({ error: "INVALID_CANCEL_REQUEST" });
      return (
        (await repo.get(p.data.deviceId, p.data.commandId)) ??
        reply.code(404).send({ error: "CANCEL_NOT_FOUND" })
      );
    },
  );
}
