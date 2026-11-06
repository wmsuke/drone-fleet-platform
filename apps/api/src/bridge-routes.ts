import {
  BridgeConfigurationError,
  type BridgeRepository,
} from "@drone-fleet/database";
import {
  bridgeDesiredSchema,
  supportsBridgeOperation,
} from "@drone-fleet/protocol";
import type { FastifyInstance } from "fastify";
import { deviceIdSchema, telemetryLimitSchema } from "./schema.js";

export function registerBridgeRoutes(
  app: FastifyInstance,
  repository: BridgeRepository,
) {
  app.get<{ Params: { deviceId: string } }>(
    "/devices/:deviceId/bridge-configuration",
    async (request, reply) => {
      const id = deviceIdSchema.safeParse(request.params.deviceId);
      if (!id.success)
        return reply.code(400).send({ error: "INVALID_DEVICE_ID" });
      const state = await repository.get(id.data);
      if (!state) return reply.code(404).send({ error: "DEVICE_NOT_FOUND" });
      const receivedAt = state.reported?.receivedAt;
      return {
        ...state,
        fresh:
          !!receivedAt &&
          Date.now() >= Date.parse(receivedAt) &&
          Date.now() - Date.parse(receivedAt) < 15000,
        supportedOperations: state.reported
          ? ["RETURN_HOME", "REBOOT"].filter((operation) =>
              supportsBridgeOperation(state.reported!.configuration, operation),
            )
          : [],
        ...(await repository.readiness(id.data)),
      };
    },
  );
  app.get<{ Params: { deviceId: string }; Querystring: { limit?: string } }>(
    "/devices/:deviceId/bridge-configuration/reports",
    async (request, reply) => {
      const id = deviceIdSchema.safeParse(request.params.deviceId);
      const limit =
        request.query.limit === undefined
          ? { success: true as const, data: 100 }
          : telemetryLimitSchema.safeParse(request.query.limit);
      if (!id.success || !limit.success)
        return reply.code(400).send({ error: "INVALID_QUERY" });
      if (!(await repository.get(id.data)))
        return reply.code(404).send({ error: "DEVICE_NOT_FOUND" });
      return repository.history(id.data, limit.data);
    },
  );
  app.put<{ Params: { deviceId: string } }>(
    "/devices/:deviceId/bridge-configuration/desired",
    async (request, reply) => {
      const id = deviceIdSchema.safeParse(request.params.deviceId);
      const body = bridgeDesiredSchema.safeParse(request.body);
      if (!id.success || !body.success)
        return reply.code(400).send({ error: "INVALID_DESIRED" });
      try {
        await repository.desired(
          id.data,
          body.data.revision,
          body.data.configurationId,
        );
        return repository.get(id.data);
      } catch (error) {
        if (!(error instanceof BridgeConfigurationError)) throw error;
        return reply
          .code(error.message === "DEVICE_NOT_FOUND" ? 404 : 409)
          .send({ error: error.message });
      }
    },
  );
  app.get<{ Params: { commandId: string } }>(
    "/commands/:commandId/bridge-execution",
    async (request, reply) => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          request.params.commandId,
        )
      )
        return reply.code(400).send({ error: "INVALID_COMMAND_ID" });
      return (
        (await repository.executionState(request.params.commandId)) ??
        reply.code(404).send({ error: "EXECUTION_NOT_FOUND" })
      );
    },
  );
  app.get<{ Params: { commandId: string } }>(
    "/commands/:commandId/bridge-configuration",
    async (request, reply) => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          request.params.commandId,
        )
      )
        return reply.code(400).send({ error: "INVALID_COMMAND_ID" });
      const result = await repository.execution(request.params.commandId);
      return (
        result ??
        reply.code(404).send({ error: "EXECUTION_CONFIGURATION_NOT_FOUND" })
      );
    },
  );
}
