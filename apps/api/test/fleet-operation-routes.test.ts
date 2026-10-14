import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerFleetOperationRoutes } from "../src/fleet-operation-routes.js";
import {
  FleetOperationError,
  loadFleetOperationOptions,
} from "../src/fleet-operation-repository.js";
import type { FleetOperationResponse } from "../src/fleet-operation-schema.js";
const groupId = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
const response: FleetOperationResponse = {
  operationId: groupId,
  groupId,
  type: "RETURN_HOME",
  status: "ACCEPTED",
  targetCount: 2,
  createdAt: "2026-10-14T00:00:00.000Z",
  expiresAt: "2026-10-14T00:00:30.000Z",
  resultDeadline: "2026-10-14T00:02:00.000Z",
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup() {
  const create = vi.fn(async () => response);
  const app = Fastify();
  registerFleetOperationRoutes(app, { create, list: vi.fn(), find: vi.fn() });
  apps.push(app);
  return { app, create };
}
it("accepts a normalized request and returns 202 without publishing MQTT", async () => {
  const { app, create } = setup();
  const result = await app.inject({
    method: "POST",
    url: "/fleet-operations",
    headers: { "Idempotency-Key": "request-001" },
    payload: { groupId: groupId.toUpperCase(), type: "RETURN_HOME" },
  });
  expect(result.statusCode).toBe(202);
  expect(result.json()).toEqual(response);
  expect(create).toHaveBeenCalledWith(
    { groupId, type: "RETURN_HOME" },
    "request-001",
  );
});
it.each([undefined, "", "space key", "x".repeat(129), "日本語", "a,b"])(
  "rejects invalid key %s before database access",
  async (key) => {
    const { app, create } = setup();
    const result = await app.inject({
      method: "POST",
      url: "/fleet-operations",
      headers: key === undefined ? {} : { "Idempotency-Key": key },
      payload: { groupId, type: "RETURN_HOME" },
    });
    expect(result.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  },
);
it.each([
  {},
  { groupId: "bad", type: "RETURN_HOME" },
  { groupId, type: "UNSUPPORTED" },
  { groupId, type: "RETURN_HOME", actor: "someone" },
])("rejects invalid body %j", async (payload) => {
  const { app, create } = setup();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/fleet-operations",
        headers: { "Idempotency-Key": "request" },
        payload,
      })
    ).statusCode,
  ).toBe(400);
  expect(create).not.toHaveBeenCalled();
});
it.each([400, 404, 409] as const)(
  "returns repository rejection %i",
  async (status) => {
    const { app, create } = setup();
    create.mockRejectedValue(new FleetOperationError(status, "受付できません"));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/fleet-operations",
          headers: { "Idempotency-Key": "request" },
          payload: { groupId, type: "RETURN_HOME" },
        })
      ).statusCode,
    ).toBe(status);
  },
);
it("validates target limit configuration", () => {
  expect(loadFleetOperationOptions({})).toEqual({ maxTargets: 100 });
  expect(
    loadFleetOperationOptions({ FLEET_OPERATION_MAX_TARGETS: "1000" }),
  ).toEqual({ maxTargets: 1000 });
  for (const value of ["0", "1001", "1.5", "", "bad"])
    expect(() =>
      loadFleetOperationOptions({ FLEET_OPERATION_MAX_TARGETS: value }),
    ).toThrow();
});
