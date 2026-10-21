import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerDeploymentRoutes } from "../src/deployment-routes.js";
import { DeploymentError } from "../src/deployment-repository.js";
import {
  assignStages,
  deploymentRequestSchema,
} from "../src/deployment-schema.js";
const releaseId = "bdfdff53-2b4b-48c8-ae86-f75b6d4c39e8";
const apps: ReturnType<typeof Fastify>[] = [];
function setup() {
  const app = Fastify();
  apps.push(app);
  const create = vi.fn(async () => ({ status: "ACCEPTED" }));
  registerDeploymentRoutes(app, { create } as never);
  return { app, create };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
it("normalizes ids and selection order before acceptance", async () => {
  const { app, create } = setup();
  const result = await app.inject({
    method: "POST",
    url: "/deployments",
    headers: { "Idempotency-Key": "test" },
    payload: { releaseId: releaseId.toUpperCase(), deviceIds: ["b", "a"] },
  });
  expect(result.statusCode).toBe(202);
  expect(create).toHaveBeenCalledWith(
    {
      releaseId,
      deviceIds: ["a", "b"],
      groupIds: [],
      evaluationVersion: "ota-health-v1",
    },
    "test",
  );
});
it.each([
  {},
  { releaseId },
  { releaseId, deviceIds: ["a", "a"] },
  { releaseId, deviceIds: ["a"], stop: { failureRate: 1 } },
  { releaseId, deviceIds: ["a"], evaluationVersion: "permissive" },
  { releaseId, deviceIds: ["a"], stages: [{ deviceIds: [] }] },
  { releaseId, deviceIds: Array.from({ length: 101 }, (_, n) => `d${n}`) },
])("rejects invalid/weakening request %j before storage", async (payload) => {
  const { app, create } = setup();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/deployments",
        headers: { "Idempotency-Key": "test" },
        payload,
      })
    ).statusCode,
  ).toBe(400);
  expect(create).not.toHaveBeenCalled();
});
it("requires an idempotency key and hides storage errors", async () => {
  const { app, create } = setup();
  const payload = { releaseId, deviceIds: ["a"] };
  expect(
    (await app.inject({ method: "POST", url: "/deployments", payload }))
      .statusCode,
  ).toBe(400);
  create.mockRejectedValue(new Error("secret path"));
  const result = await app.inject({
    method: "POST",
    url: "/deployments",
    headers: { "Idempotency-Key": "test" },
    payload,
  });
  expect(result.statusCode).toBe(503);
  expect(result.body).not.toContain("secret");
  create.mockRejectedValue(new DeploymentError(429, "DEPLOYMENT_RATE_LIMITED"));
  const rate = await app.inject({
    method: "POST",
    url: "/deployments",
    headers: { "Idempotency-Key": "test" },
    payload,
  });
  expect(rate.statusCode).toBe(429);
  expect(rate.headers["retry-after"]).toBe("1");
});
it("assigns 1/3/6 and rejects missing, duplicate, or out-of-order stage members", () => {
  const devices = Array.from({ length: 10 }, (_, n) => `d${n}`);
  expect(assignStages(devices).map((s) => s.length)).toEqual([1, 3, 6]);
  expect(assignStages(["a"])).toEqual([["a"]]);
  for (const stages of [
    [{ deviceIds: ["a"] }],
    [{ deviceIds: ["a", "a"] }],
    [{ deviceIds: ["b"] }, { deviceIds: ["a"] }],
  ])
    expect(() => assignStages(["a", "b"], stages)).toThrow("INVALID_STAGES");
  expect(
    deploymentRequestSchema.parse({ releaseId, groupIds: [releaseId] })
      .deviceIds,
  ).toEqual([]);
});
