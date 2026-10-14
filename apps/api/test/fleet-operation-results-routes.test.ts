import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerFleetOperationRoutes } from "../src/fleet-operation-routes.js";
import {
  operationDetailResponseSchema,
  operationListQuerySchema,
  type OperationDetailResponse,
} from "../src/fleet-operation-schema.js";

const id = "6957ca77-f1d7-4598-863a-28faf7496f62";
const detail: OperationDetailResponse = {
  operationId: id,
  groupId: id,
  groupName: "試験隊",
  groupRevision: 1,
  type: "REBOOT",
  status: "PARTIALLY_FAILED",
  targetCount: 2,
  createdAt: "2026-10-14T00:00:00.000Z",
  expiresAt: "2026-10-14T00:00:30.000Z",
  resultDeadline: "2026-10-14T00:02:00.000Z",
  evaluatedAt: "2026-10-14T00:02:00.000Z",
  updatedAt: "2026-10-14T00:02:00.000Z",
  counts: {
    PENDING: 0,
    SENT: 0,
    ACKNOWLEDGED: 0,
    RUNNING: 0,
    SUCCEEDED: 1,
    EXECUTION_FAILED: 0,
    DELIVERY_FAILED: 0,
    EXPIRED: 0,
    UNRESPONSIVE: 1,
    UNCERTAIN: 0,
  },
  succeededCount: 1,
  unsuccessfulCount: 1,
  inProgressCount: 0,
  acknowledgedCount: 0,
  targets: { items: [], total: 1, limit: 1, offset: 1 },
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup() {
  const find = vi.fn(
    async (): Promise<OperationDetailResponse | null> => detail,
  );
  const list = vi.fn(async () => ({
    items: [detail],
    total: 1,
    limit: 20,
    offset: 0,
    evaluatedAt: detail.evaluatedAt,
  }));
  const create = vi.fn();
  const app = Fastify();
  registerFleetOperationRoutes(app, { find, list, create });
  apps.push(app);
  return { app, find, list, create };
}
it("returns paginated operation summaries with defaults and without MQTT or writes", async () => {
  const { app, list, create, find } = setup();
  const result = await app.inject(`/fleet-operations`);
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    total: 1,
    limit: 20,
    offset: 0,
    items: [{ status: "PARTIALLY_FAILED" }],
  });
  expect(result.json().items[0]).not.toHaveProperty("targets");
  expect(list).toHaveBeenCalledWith({ limit: 20, offset: 0 });
  expect(find).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it("normalizes IDs and passes validated list filters", async () => {
  const { app, list } = setup();
  expect(
    (
      await app.inject(
        `/fleet-operations?groupId=${id.toUpperCase()}&type=REBOOT&status=FAILED&limit=3&offset=2&from=2026-10-14T00:00:00Z&to=2026-10-15T00:00:00Z`,
      )
    ).statusCode,
  ).toBe(200);
  expect(list).toHaveBeenCalledWith({
    groupId: id,
    type: "REBOOT",
    status: "FAILED",
    limit: 3,
    offset: 2,
    from: "2026-10-14T00:00:00Z",
    to: "2026-10-15T00:00:00Z",
  });
});
it("returns whole-operation counts separately from the filtered target page", async () => {
  const { app, find } = setup();
  const result = await app.inject(
    `/fleet-operations/${id.toUpperCase()}?limit=1&offset=1&status=SUCCEEDED&deviceId=drone-001`,
  );
  expect(result.statusCode).toBe(200);
  expect(operationDetailResponseSchema.parse(result.json())).toEqual(detail);
  expect(find).toHaveBeenCalledWith(id, {
    limit: 1,
    offset: 1,
    status: "SUCCEEDED",
    deviceId: "drone-001",
  });
});
it("uses default target pagination and returns 404 for an unknown operation", async () => {
  const { app, find } = setup();
  find.mockResolvedValue(null);
  expect((await app.inject(`/fleet-operations/${id}`)).statusCode).toBe(404);
  expect(find).toHaveBeenCalledWith(id, { limit: 100, offset: 0 });
});
it.each([
  "limit=0",
  "limit=101",
  "limit=1.5",
  "limit=01",
  "limit=",
  "limit=1&limit=2",
  "offset=-1",
  "offset=1000001",
  "offset=1e2",
  "groupId=bad",
  "type=BAD",
  "status=RUNNING",
  "from=bad",
  "from=2026-10-15T00:00:00Z&to=2026-10-14T00:00:00Z",
  "unknown=true",
])("rejects invalid list query %s before reading", async (query) => {
  const { app, list } = setup();
  expect((await app.inject(`/fleet-operations?${query}`)).statusCode).toBe(400);
  expect(list).not.toHaveBeenCalled();
});
it.each([
  "bad",
  `${id}?limit=101`,
  `${id}?offset=-1`,
  `${id}?status=FAILED`,
  `${id}?deviceId=a/b`,
  `${id}?groupId=${id}`,
  `${id}?offset=1&offset=2`,
])("rejects invalid detail input %s", async (path) => {
  const { app, find } = setup();
  expect((await app.inject(`/fleet-operations/${path}`)).statusCode).toBe(400);
  expect(find).not.toHaveBeenCalled();
});
it("compares time filters chronologically despite different fractional precision", () => {
  expect(
    operationListQuerySchema.safeParse({
      from: "2026-10-14T00:00:00Z",
      to: "2026-10-14T00:00:00.001Z",
    }).success,
  ).toBe(true);
  expect(
    operationListQuerySchema.safeParse({
      from: "2026-10-14T00:00:00.001Z",
      to: "2026-10-14T00:00:00Z",
    }).success,
  ).toBe(false);
});
it("does not hide unexpected database failures as an empty page or 404", async () => {
  const { app, list, find } = setup();
  list.mockRejectedValue(new Error("DB unavailable"));
  find.mockRejectedValue(new Error("DB unavailable"));
  expect((await app.inject(`/fleet-operations`)).statusCode).toBe(500);
  expect((await app.inject(`/fleet-operations/${id}`)).statusCode).toBe(500);
});
