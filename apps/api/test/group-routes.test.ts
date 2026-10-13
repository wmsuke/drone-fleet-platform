import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGroupRoutes } from "../src/group-routes.js";
import {
  GroupRepositoryError,
  type GroupRepository,
} from "../src/group-repository.js";

const id = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
const group = {
  groupId: id,
  name: "訓練隊",
  description: null,
  revision: 1,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  deviceCount: 0,
  deviceIds: [],
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup() {
  const repository: GroupRepository = {
    list: vi.fn(async () => [group]),
    find: vi.fn(async () => group),
    create: vi.fn(async () => group),
    update: vi.fn(async () => group),
    remove: vi.fn(async () => {}),
    addMember: vi.fn(async () => group),
    removeMember: vi.fn(async () => group),
  };
  const app = Fastify();
  registerGroupRoutes(app, repository);
  apps.push(app);
  return { app, repository };
}
describe("group API", () => {
  it("rejects NUL in descriptions before touching the database", async () => {
    const { app, repository } = setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/groups",
          payload: { name: "隊", description: "a\u0000b" },
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
  });
  it("lists, reads, creates, updates and deletes groups", async () => {
    const { app, repository } = setup();
    expect((await app.inject("/groups")).json()).toEqual([group]);
    expect((await app.inject(`/groups/${id}`)).json()).toEqual(group);
    const created = await app.inject({
      method: "POST",
      url: "/groups",
      payload: { name: " 訓練隊 " },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(group);
    expect(repository.create).toHaveBeenCalledWith({ name: "訓練隊" });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/groups/${id}`,
          payload: { description: null },
        })
      ).statusCode,
    ).toBe(200);
    expect(repository.update).toHaveBeenCalledWith(id, { description: null });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/groups/${id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
  });
  it("adds and removes a device", async () => {
    const { app, repository } = setup();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/groups/${id}/devices`,
          payload: { deviceId: "drone-001" },
        })
      ).statusCode,
    ).toBe(201);
    expect(repository.addMember).toHaveBeenCalledWith(id, "drone-001");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/groups/${id}/devices/drone-001`,
        })
      ).statusCode,
    ).toBe(204);
    expect(repository.removeMember).toHaveBeenCalledWith(id, "drone-001");
  });
  it.each([
    {},
    { name: " " },
    { name: "x".repeat(101) },
    { name: "a\nb" },
    { name: "隊", extra: true },
    { name: "隊", description: "x".repeat(1001) },
  ])("rejects invalid creation: %j", async (payload) => {
    const { app, repository } = setup();
    expect(
      (await app.inject({ method: "POST", url: "/groups", payload }))
        .statusCode,
    ).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs and empty updates without repository calls", async () => {
    const { app, repository } = setup();
    expect((await app.inject("/groups/not-a-uuid")).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: `/groups/${id}`, payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/groups/${id}/devices`,
          payload: { deviceId: "invalid/device" },
        })
      ).statusCode,
    ).toBe(400);
    expect(repository.find).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.addMember).not.toHaveBeenCalled();
  });
  it.each([404, 409] as const)(
    "maps repository rejection to %i",
    async (status) => {
      const { app, repository } = setup();
      vi.mocked(repository.addMember).mockRejectedValue(
        new GroupRepositoryError(status, "登録できません"),
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/groups/${id}/devices`,
            payload: { deviceId: "drone-001" },
          })
        ).statusCode,
      ).toBe(status);
    },
  );
  it("returns 500 for unexpected database failures", async () => {
    const { app, repository } = setup();
    vi.mocked(repository.find).mockRejectedValue(
      new Error("database unavailable"),
    );
    expect((await app.inject(`/groups/${id}`)).statusCode).toBe(500);
  });
});
