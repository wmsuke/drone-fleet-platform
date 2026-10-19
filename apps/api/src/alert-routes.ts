import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AlertRepository } from "./alert-repository.js";
import {
  alertListSchema,
  alertQuerySchema,
  alertSchema,
} from "./alert-schema.js";
export function registerAlertRoutes(
  app: FastifyInstance,
  repository: AlertRepository,
) {
  app.get("/alerts", async (request, reply) => {
    const query = alertQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "絞り込み条件が不正です" });
    return alertListSchema.parse(await repository.list(query.data));
  });
  for (const method of ["GET", "POST"] as const)
    app.route({
      method,
      url:
        method === "GET" ? "/alerts/:alertId" : "/alerts/:alertId/acknowledge",
      handler: async (request, reply) => {
        const params = z
          .object({ alertId: z.uuid() })
          .safeParse(request.params);
        if (
          !params.success ||
          (method === "POST" &&
            request.body !== undefined &&
            !z.object({}).strict().safeParse(request.body).success)
        )
          return reply.code(400).send({ error: "入力が不正です" });
        const item = await repository[
          method === "GET" ? "find" : "acknowledge"
        ](params.data.alertId);
        return item
          ? alertSchema.parse(item)
          : reply.code(404).send({ error: "alertが見つかりません" });
      },
    });
}
