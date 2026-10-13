import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GroupRepositoryError,
  type GroupRepository,
} from "./group-repository.js";
import {
  createGroupSchema,
  updateGroupSchema,
  groupIdSchema,
  groupMemberSchema,
  groupResponseSchema,
} from "./group-schema.js";
import { deviceIdSchema } from "./schema.js";

export function registerGroupRoutes(
  app: FastifyInstance,
  repository: GroupRepository,
) {
  const params = z.object({ groupId: groupIdSchema });
  const memberParams = params.extend({ deviceId: deviceIdSchema });
  const route = <T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    input: z.ZodType<T>,
    action: (value: T) => Promise<unknown>,
    status = 200,
  ) => {
    app.route({
      method,
      url,
      handler: async (request, reply) => {
        const parsed = input.safeParse({
          params: request.params,
          body: request.body,
        });
        if (!parsed.success)
          return reply.code(400).send({ error: "入力が不正です" });
        try {
          return reply.code(status).send(await action(parsed.data));
        } catch (error) {
          if (error instanceof GroupRepositoryError)
            return reply.code(error.status).send({ error: error.message });
          throw error;
        }
      },
    });
  };
  app.get("/groups", async () =>
    z.array(groupResponseSchema).parse(await repository.list()),
  );
  route(
    "POST",
    "/groups",
    z.object({ params: z.object({}), body: createGroupSchema }),
    async (v) => groupResponseSchema.parse(await repository.create(v.body)),
    201,
  );
  route("GET", "/groups/:groupId", z.object({ params }), async (v) =>
    groupResponseSchema.parse(await repository.find(v.params.groupId)),
  );
  route(
    "PATCH",
    "/groups/:groupId",
    z.object({ params, body: updateGroupSchema }),
    async (v) =>
      groupResponseSchema.parse(
        await repository.update(v.params.groupId, v.body),
      ),
  );
  route(
    "DELETE",
    "/groups/:groupId",
    z.object({ params }),
    async (v) => {
      await repository.remove(v.params.groupId);
    },
    204,
  );
  route(
    "POST",
    "/groups/:groupId/devices",
    z.object({ params, body: groupMemberSchema }),
    async (v) =>
      groupResponseSchema.parse(
        await repository.addMember(v.params.groupId, v.body.deviceId),
      ),
    201,
  );
  route(
    "DELETE",
    "/groups/:groupId/devices/:deviceId",
    z.object({ params: memberParams }),
    async (v) => {
      await repository.removeMember(v.params.groupId, v.params.deviceId);
    },
    204,
  );
}
