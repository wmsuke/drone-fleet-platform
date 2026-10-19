import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerAuditQueryRoutes } from "../src/audit-query-routes.js";
import type { AuditQueryRepository } from "../src/audit-query-repository.js";
import {
  auditQuerySchema,
  decodeAuditCursor,
  encodeAuditCursor,
  publicMetadata,
} from "../src/audit-schema.js";
const id = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
function setup() {
  const repository: AuditQueryRepository = {
    list: vi.fn(async (q) => ({ items: [], limit: q.limit, nextCursor: null })),
    find: vi.fn(async () => null),
  };
  const app = Fastify();
  apps.push(app);
  registerAuditQueryRoutes(app, repository);
  return { app, repository };
}
it("validates filters and cursor before querying, rejects ambiguous/unknown parameters", async () => {
  const { app, repository } = setup();
  expect(
    (
      await app.inject(
        `/audit-logs?actorKind=system&actorId=telemetry-ingestor&action=command.accepted&targetKind=command&targetId=${id}&result=REJECTED&requestId=${id}&limit=10`,
      )
    ).statusCode,
  ).toBe(200);
  expect(repository.list).toHaveBeenCalledWith(
    expect.objectContaining({
      actorKind: "system",
      result: "REJECTED",
      limit: 10,
    }),
  );
  for (const q of [
    "cursor=bad",
    "actorKind=admin",
    "actorId=person",
    "action=unknown",
    "targetKind=unknown",
    "targetId=a/b",
    "result=unknown",
    "requestId=bad",
    "limit=101",
    "offset=1",
    "result=FAILED&result=SUCCEEDED",
    "from=invalid",
    "from=2026-10-19T00:00:00.123457Z&to=2026-10-19T00:00:00.123456Z",
  ]) {
    expect((await app.inject(`/audit-logs?${q}`)).statusCode).toBe(400);
  }
  expect(repository.list).toHaveBeenCalledTimes(1);
});
it("preserves six fractional digits in cursors and validates calendar/precision", () => {
  const value = encodeAuditCursor("2026-10-19T00:00:00.123456Z", id);
  expect(decodeAuditCursor(value)).toEqual({
    time: "2026-10-19T00:00:00.123456Z",
    id,
  });
  expect(
    decodeAuditCursor(
      Buffer.from('{"time":"bad","id":"bad"}').toString("base64url"),
    ),
  ).toBeNull();
  expect(
    auditQuerySchema.safeParse({
      from: "2026-10-19T00:00:00Z",
      to: "2026-10-19T00:00:00.000001Z",
    }).success,
  ).toBe(true);
  for (const from of ["2026-02-30T00:00:00Z", "2026-10-19T00:00:00.1234567Z"]) {
    expect(auditQuerySchema.safeParse({ from }).success).toBe(false);
  }
});
it("publishes only action-appropriate validated metadata", () => {
  expect(
    publicMetadata("group.updated", "SUCCEEDED", {
      beforeName: "前",
      afterName: "後",
      descriptionChanged: true,
      authorization: "test-private-value",
      reason: "SHOULD_NOT_APPEAR",
      targetCount: 99,
    }),
  ).toEqual({ beforeName: "前", afterName: "後", descriptionChanged: true });
  expect(
    publicMetadata("group.created", "FAILED", {
      afterName: "非公開",
      reason: "INTERNAL_ERROR",
      statusCode: 500,
      private: "test-private-value",
    }),
  ).toEqual({ reason: "INTERNAL_ERROR", statusCode: 500 });
  expect(
    publicMetadata("command.conflict", "REJECTED", {
      reason: "RESULT_CONFLICT",
      beforeStatus: "RUNNING",
      afterStatus: "FAILED",
    }),
  ).toEqual({
    reason: "RESULT_CONFLICT",
    beforeStatus: "RUNNING",
    afterStatus: "FAILED",
  });
  expect(
    publicMetadata("membership.added", "SUCCEEDED", {
      memberDeviceId: [],
      private: { value: "test-private-value" },
    }),
  ).toEqual({});
});
it("returns missing/invalid detail errors, propagates DB failure and exposes no mutation routes", async () => {
  const { app, repository } = setup();
  expect((await app.inject(`/audit-logs/${id}`)).statusCode).toBe(404);
  expect((await app.inject("/audit-logs/bad")).statusCode).toBe(400);
  for (const method of ["POST", "PATCH", "DELETE"] as const)
    expect(
      (await app.inject({ method, url: `/audit-logs/${id}` })).statusCode,
    ).toBe(404);
  vi.mocked(repository.list).mockRejectedValue(Error("database unavailable"));
  expect((await app.inject("/audit-logs")).statusCode).toBe(500);
});
