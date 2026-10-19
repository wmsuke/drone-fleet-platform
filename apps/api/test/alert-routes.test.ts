import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerAlertRoutes } from "../src/alert-routes.js";
import type { AlertRepository } from "../src/alert-repository.js";
import { alertQuerySchema } from "../src/alert-schema.js";
const id = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
const apps: ReturnType<typeof Fastify>[] = [];
const alert = {
  alertId: id,
  deviceId: "drone-001",
  commandId: null,
  kind: "OFFLINE",
  status: "ACTIVE",
  severity: "warning",
  reason: "OFFLINE",
  occurredAt: "2026-10-19T00:00:00Z",
  lastObservedAt: "2026-10-19T00:00:00Z",
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedActorKind: null,
  acknowledgedActorId: null,
  ruleVersion: "test",
  parameters: {},
  evidence: {},
  relatedGroups: [],
  operationId: null,
} as const;
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
function setup() {
  const repository: AlertRepository = {
    list: vi.fn(async (q) => ({
      items: [],
      total: 0,
      limit: q.limit,
      offset: q.offset,
    })),
    find: vi.fn(async () => null),
    acknowledge: vi.fn(async () => null),
  };
  const app = Fastify();
  apps.push(app);
  registerAlertRoutes(app, repository);
  return { app, repository };
}
it("returns validated detail and acknowledgement without changing automatic status", async () => {
  const { app, repository } = setup();
  vi.mocked(repository.find).mockResolvedValue({ ...alert, relatedGroups: [] });
  vi.mocked(repository.acknowledge).mockResolvedValue({
    ...alert,
    relatedGroups: [],
    acknowledgedAt: "2026-10-19T01:00:00Z",
    acknowledgedActorKind: "anonymous",
  });
  expect((await app.inject(`/alerts/${id}`)).json()).toMatchObject({
    status: "ACTIVE",
    acknowledgedAt: null,
  });
  expect(
    (
      await app.inject({ method: "POST", url: `/alerts/${id}/acknowledge` })
    ).json(),
  ).toMatchObject({
    status: "ACTIVE",
    resolvedAt: null,
    acknowledgedActorKind: "anonymous",
  });
});
it("validates filters and pagination before reading alerts", async () => {
  const { app, repository } = setup();
  expect(
    (
      await app.inject(
        "/alerts?status=RESOLVED&acknowledged=false&limit=2&offset=4",
      )
    ).json(),
  ).toEqual({ items: [], total: 0, limit: 2, offset: 4 });
  expect(repository.list).toHaveBeenCalledWith({
    status: "RESOLVED",
    acknowledged: "false",
    limit: 2,
    offset: 4,
  });
  for (const query of [
    "status=no",
    "severity=critical",
    "kind=no",
    "acknowledged=yes",
    "limit=101",
    "offset=-1",
    "offset=1e3",
    "groupId=no",
    "deviceId=a/b",
    "unknown=1",
    "from=2026-10-20T00:00:00Z&to=2026-10-19T00:00:00Z",
  ]) {
    expect((await app.inject(`/alerts?${query}`)).statusCode).toBe(400);
  }
  expect(repository.list).toHaveBeenCalledTimes(1);
});
it("compares fractional timestamps chronologically", () => {
  expect(
    alertQuerySchema.safeParse({
      from: "2026-10-19T00:00:00Z",
      to: "2026-10-19T00:00:00.001Z",
    }).success,
  ).toBe(true);
});
it("returns 404 for missing details/ack, rejects identity injection", async () => {
  const { app, repository } = setup();
  expect((await app.inject(`/alerts/${id}`)).statusCode).toBe(404);
  expect(
    (await app.inject({ method: "POST", url: `/alerts/${id}/acknowledge` }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/alerts/${id}/acknowledge`,
        payload: { actorId: "admin" },
      })
    ).statusCode,
  ).toBe(400);
  expect(repository.acknowledge).toHaveBeenCalledTimes(1);
  expect((await app.inject("/alerts/invalid")).statusCode).toBe(400);
});
it("returns server failures without claiming acknowledgement succeeded", async () => {
  const { app, repository } = setup();
  vi.mocked(repository.acknowledge).mockRejectedValue(
    new Error("database unavailable"),
  );
  expect(
    (await app.inject({ method: "POST", url: `/alerts/${id}/acknowledge` }))
      .statusCode,
  ).toBe(500);
});
