import Fastify, { type FastifyInstance } from "fastify";

import type { DeviceRepository } from "./repository.js";
import {
  deviceDetailSchema,
  deviceIdSchema,
  deviceListResponseSchema,
} from "./schema.js";

export function buildApi(repository: DeviceRepository): FastifyInstance {
  const app = Fastify();

  app.get("/devices", async () => {
    const devices = await repository.list();
    return deviceListResponseSchema.parse(devices);
  });

  app.get<{ Params: { deviceId: string } }>(
    "/devices/:deviceId",
    async (request, reply) => {
      const parsedDeviceId = deviceIdSchema.safeParse(request.params.deviceId);
      if (!parsedDeviceId.success) {
        return reply.code(400).send({ error: "deviceIdの形式が不正です" });
      }
      const device = await repository.findById(parsedDeviceId.data);
      if (device === null) {
        return reply.code(404).send({ error: "deviceが見つかりません" });
      }
      return deviceDetailSchema.parse(device);
    },
  );

  return app;
}
