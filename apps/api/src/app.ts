import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import type { DeviceRepository } from "./repository.js";
import {
  CommandPublishError,
  DeviceNotFoundError,
  type CommandService,
} from "./command-service.js";
import {
  commandRequestSchema,
  commandHistoryResponseSchema,
  commandResponseSchema,
  deviceDetailSchema,
  deviceIdSchema,
  deviceListResponseSchema,
  telemetryHistoryResponseSchema,
  telemetryLimitSchema,
} from "./schema.js";

const DEFAULT_TELEMETRY_LIMIT = 100;
const DEFAULT_COMMAND_LIMIT = 100;

export function buildApi(
  repository: DeviceRepository,
  commandService: CommandService,
  options: { dashboardOrigin?: string | null } = {},
): FastifyInstance {
  const app = Fastify();
  if (
    options.dashboardOrigin !== undefined &&
    options.dashboardOrigin !== null
  ) {
    const dashboardOrigin = options.dashboardOrigin;
    void app.register(cors, {
      origin(origin, callback) {
        callback(null, origin === dashboardOrigin);
      },
    });
  }

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

  app.post<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/commands",
    async (request, reply) => {
      const parsedDeviceId = deviceIdSchema.safeParse(request.params.deviceId);
      const parsedBody = commandRequestSchema.safeParse(request.body);
      if (!parsedDeviceId.success || !parsedBody.success) {
        return reply.code(400).send({ error: "入力が不正です" });
      }
      try {
        const command = await commandService.send(
          parsedDeviceId.data,
          parsedBody.data.type,
        );
        return reply.code(202).send(commandResponseSchema.parse(command));
      } catch (error) {
        if (error instanceof DeviceNotFoundError) {
          return reply.code(404).send({ error: "deviceが見つかりません" });
        }
        if (error instanceof CommandPublishError) {
          return reply
            .code(502)
            .send(commandResponseSchema.parse(error.command));
        }
        throw error;
      }
    },
  );

  app.get<{
    Params: { deviceId: string };
    Querystring: { limit?: string };
  }>("/devices/:deviceId/commands", async (request, reply) => {
    const parsedDeviceId = deviceIdSchema.safeParse(request.params.deviceId);
    if (!parsedDeviceId.success) {
      return reply.code(400).send({ error: "deviceIdの形式が不正です" });
    }
    const parsedLimit =
      request.query.limit === undefined
        ? { success: true as const, data: DEFAULT_COMMAND_LIMIT }
        : telemetryLimitSchema.safeParse(request.query.limit);
    if (!parsedLimit.success) {
      return reply.code(400).send({ error: "limitは1から1000の整数です" });
    }
    const history = await commandService.history(
      parsedDeviceId.data,
      parsedLimit.data,
    );
    if (history === null) {
      return reply.code(404).send({ error: "deviceが見つかりません" });
    }
    return commandHistoryResponseSchema.parse(history);
  });

  return app;
}
