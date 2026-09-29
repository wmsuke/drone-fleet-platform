import Fastify, { type FastifyInstance } from "fastify";

import type { DeviceListRepository } from "./repository.js";
import { deviceListResponseSchema } from "./schema.js";

export function buildApi(repository: DeviceListRepository): FastifyInstance {
  const app = Fastify();

  app.get("/devices", async () => {
    const devices = await repository.list();
    return deviceListResponseSchema.parse(devices);
  });

  return app;
}
