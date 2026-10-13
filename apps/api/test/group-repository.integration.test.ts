import {
  createDatabase,
  devices,
  groups,
  groupMemberships,
} from "@drone-fleet/database";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGroupRepository } from "../src/group-repository.js";
import { buildApi } from "../src/app.js";
import { createDeviceRepository } from "../src/repository.js";
import { createCommandRepository } from "../src/command-repository.js";
import { createCommandService } from "../src/command-service.js";

const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const ids = ["integration-group-001", "integration-group-002"];
const createdIds: string[] = [];
function configured() {
  if (!database) throw new Error("integration database is not configured");
  return database;
}
async function cleanup() {
  const { db } = configured();
  if (createdIds.length) {
    await db
      .delete(groupMemberships)
      .where(inArray(groupMemberships.groupId, createdIds));
    await db
      .delete(groups)
      .where(inArray(groups.groupId, createdIds.splice(0)));
  }
  await db.delete(devices).where(inArray(devices.deviceId, ids));
}
async function create(name = "訓練隊") {
  const result = await createGroupRepository(configured().db).create({ name });
  createdIds.push(result.groupId);
  return result;
}
describe.skipIf(!enabled)("group repository and API with PostgreSQL", () => {
  beforeAll(async () => {
    await migrate(configured().db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
  });
  beforeEach(async () => {
    await cleanup();
    await configured()
      .db.insert(devices)
      .values(ids.map((deviceId) => ({ deviceId })));
  });
  afterAll(async () => {
    await cleanup();
    await configured().client.end();
  });
  it("creates empty groups, updates metadata and returns sorted memberships/counts", async () => {
    const repo = createGroupRepository(configured().db);
    const group = await create();
    expect(group).toMatchObject({
      revision: 1,
      deviceCount: 0,
      deviceIds: [],
      description: null,
    });
    await repo.addMember(group.groupId, ids[1]!);
    await repo.addMember(group.groupId, ids[0]!);
    const updated = await repo.update(group.groupId, {
      name: "点検隊",
      description: "格納庫A",
    });
    expect(updated).toMatchObject({
      name: "点検隊",
      description: "格納庫A",
      revision: 4,
      deviceCount: 2,
      deviceIds: ids,
    });
    expect(
      (await repo.list()).find((item) => item.groupId === group.groupId),
    ).toEqual(updated);
    expect(await repo.removeMember(group.groupId, ids[0]!)).toMatchObject({
      revision: 5,
      deviceCount: 1,
      deviceIds: [ids[1]],
    });
  });
  it("allows multiple groups and serializes concurrent duplicate additions", async () => {
    const repo = createGroupRepository(configured().db);
    const first = await create();
    const second = await create();
    const outcomes = await Promise.allSettled([
      repo.addMember(first.groupId, ids[0]!),
      repo.addMember(first.groupId, ids[0]!),
    ]);
    expect(
      outcomes.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(outcomes.find((value) => value.status === "rejected")).toMatchObject(
      { reason: { status: 409 } },
    );
    await repo.addMember(second.groupId, ids[0]!);
    expect(await repo.find(first.groupId)).toMatchObject({
      revision: 2,
      deviceCount: 1,
    });
    expect(await repo.find(second.groupId)).toMatchObject({
      deviceIds: [ids[0]],
    });
  });
  it("keeps the deleted group identity and memberships, blocks mutation and hides it", async () => {
    const { db } = configured();
    const repo = createGroupRepository(db);
    const group = await create();
    await repo.addMember(group.groupId, ids[0]!);
    await repo.remove(group.groupId);
    expect(await repo.list()).not.toContainEqual(
      expect.objectContaining({ groupId: group.groupId }),
    );
    await expect(repo.find(group.groupId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      repo.update(group.groupId, { name: "戻す" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(repo.addMember(group.groupId, ids[1]!)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      repo.removeMember(group.groupId, ids[0]!),
    ).rejects.toMatchObject({ status: 404 });
    const [stored] = await db
      .select()
      .from(groups)
      .where(eq(groups.groupId, group.groupId));
    expect(stored).toMatchObject({
      name: "訓練隊",
      revision: 3,
      deletedAt: expect.any(Date),
    });
    expect(
      await db
        .select()
        .from(groupMemberships)
        .where(eq(groupMemberships.groupId, group.groupId)),
    ).toHaveLength(1);
  });
  it("rolls back rejected mutations and enforces migration constraints", async () => {
    const { db } = configured();
    const repo = createGroupRepository(db);
    const group = await create();
    await expect(
      repo.addMember(group.groupId, "missing-device"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      repo.removeMember(group.groupId, ids[0]!),
    ).rejects.toMatchObject({ status: 404 });
    await expect(repo.update(group.groupId, { name: " " })).rejects.toThrow();
    expect(await repo.find(group.groupId)).toMatchObject({
      revision: 1,
      name: "訓練隊",
    });
    await expect(
      db
        .insert(groupMemberships)
        .values({ groupId: group.groupId, deviceId: "missing-device" }),
    ).rejects.toThrow();
    await repo.addMember(group.groupId, ids[0]!);
    await expect(
      db
        .insert(groupMemberships)
        .values({ groupId: group.groupId, deviceId: ids[0]! }),
    ).rejects.toThrow();
    await expect(
      db.delete(groups).where(eq(groups.groupId, group.groupId)),
    ).rejects.toThrow();
    await expect(
      db.delete(devices).where(eq(devices.deviceId, ids[0]!)),
    ).rejects.toThrow();
  });
  it("serializes concurrent membership and metadata changes without losing revision", async () => {
    const repo = createGroupRepository(configured().db);
    const group = await create();
    await Promise.all([
      repo.addMember(group.groupId, ids[0]!),
      repo.addMember(group.groupId, ids[1]!),
      repo.update(group.groupId, { name: "更新隊" }),
    ]);
    expect(await repo.find(group.groupId)).toMatchObject({
      name: "更新隊",
      revision: 4,
      deviceIds: ids,
    });
  });
  it("exposes the production routes and preserves the existing device API", async () => {
    const { db } = configured();
    const app = buildApi(
      createDeviceRepository(db),
      createCommandService(createCommandRepository(db)),
      { groupRepository: createGroupRepository(db) },
    );
    try {
      const created = await app.inject({
        method: "POST",
        url: "/groups",
        payload: { name: " API隊 " },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json<{ groupId: string }>().groupId;
      createdIds.push(id);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/groups/${id}/devices`,
            payload: { deviceId: ids[0] },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/groups/${id}/devices`,
            payload: { deviceId: ids[0] },
          })
        ).statusCode,
      ).toBe(409);
      expect((await app.inject(`/groups/${id}`)).json()).toMatchObject({
        name: "API隊",
        deviceCount: 1,
        deviceIds: [ids[0]],
      });
      expect((await app.inject(`/devices/${ids[0]}`)).statusCode).toBe(200);
      expect(
        (await app.inject({ method: "DELETE", url: `/groups/${id}` }))
          .statusCode,
      ).toBe(204);
      expect((await app.inject(`/groups/${id}`)).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
