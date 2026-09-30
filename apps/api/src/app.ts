import Fastify, { type FastifyInstance } from "fastify";

import type { DeviceRepository } from "./repository.js";
import {
  deviceDetailSchema,
  deviceIdSchema,
  deviceListResponseSchema,
  telemetryHistoryResponseSchema,
  telemetryLimitSchema,
} from "./schema.js";

const DEFAULT_TELEMETRY_LIMIT = 100;

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

  app.get<{
    Params: { deviceId: string };
    Querystring: { limit?: string };
  }>("/devices/:deviceId/telemetry", async (request, reply) => {
    const parsedDeviceId = deviceIdSchema.safeParse(request.params.deviceId);
    if (!parsedDeviceId.success) {
      return reply.code(400).send({ error: "deviceIdの形式が不正です" });
    }
    const parsedLimit =
      request.query.limit === undefined
        ? { success: true as const, data: DEFAULT_TELEMETRY_LIMIT }
        : telemetryLimitSchema.safeParse(request.query.limit);
    if (!parsedLimit.success) {
      return reply.code(400).send({ error: "limitは1から1000の整数です" });
    }
    const history = await repository.telemetryHistory(
      parsedDeviceId.data,
      parsedLimit.data,
    );
    if (history === null) {
      return reply.code(404).send({ error: "deviceが見つかりません" });
    }
    return telemetryHistoryResponseSchema.parse(history);
  });

  return app;
}
