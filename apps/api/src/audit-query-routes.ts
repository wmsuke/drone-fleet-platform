import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuditQueryRepository } from "./audit-query-repository.js";
import {
  auditQuerySchema,
  auditPageSchema,
  auditItemSchema,
  decodeAuditCursor,
} from "./audit-schema.js";
export function registerAuditQueryRoutes(
  app: FastifyInstance,
  repository: AuditQueryRepository,
) {
  app.get("/audit-logs", async (request, reply) => {
    const parsed = auditQuerySchema.safeParse(request.query);
    if (
      !parsed.success ||
      (parsed.data.cursor && !decodeAuditCursor(parsed.data.cursor))
    )
      return reply.code(400).send({ error: "検索条件またはcursorが不正です" });
    return auditPageSchema.parse(await repository.list(parsed.data));
  });
  app.get("/audit-logs/:eventId", async (request, reply) => {
    const params = z.object({ eventId: z.uuid() }).safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "eventIdの形式が不正です" });
    const item = await repository.find(params.data.eventId);
    return item
      ? auditItemSchema.parse(item)
      : reply.code(404).send({ error: "audit logが見つかりません" });
  });
}
