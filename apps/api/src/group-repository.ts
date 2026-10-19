import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  devices,
  groups,
  groupMemberships,
  appendAudit,
  type Database,
} from "@drone-fleet/database";
import type { CreateGroup, Group, UpdateGroup } from "./group-schema.js";

export class GroupRepositoryError extends Error {
  constructor(
    public readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
export interface GroupRepository {
  list(): Promise<Group[]>;
  find(groupId: string): Promise<Group>;
  create(input: CreateGroup): Promise<Group>;
  update(groupId: string, input: UpdateGroup): Promise<Group>;
  remove(groupId: string): Promise<void>;
  addMember(groupId: string, deviceId: string): Promise<Group>;
  removeMember(groupId: string, deviceId: string): Promise<Group>;
}
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Database | Transaction;

async function read(db: Reader, groupId?: string): Promise<Group[]> {
  const rows = await db
    .select({ group: groups, deviceId: groupMemberships.deviceId })
    .from(groups)
    .leftJoin(groupMemberships, eq(groups.groupId, groupMemberships.groupId))
    .where(
      and(
        isNull(groups.deletedAt),
        groupId === undefined ? undefined : eq(groups.groupId, groupId),
      ),
    )
    .orderBy(
      asc(groups.createdAt),
      asc(groups.groupId),
      asc(groupMemberships.deviceId),
    );
  const result = new Map<string, Group>();
  for (const { group, deviceId } of rows) {
    let item = result.get(group.groupId);
    if (!item) {
      item = {
        groupId: group.groupId,
        name: group.name,
        description: group.description,
        revision: group.revision,
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
        deviceCount: 0,
        deviceIds: [],
      };
      result.set(group.groupId, item);
    }
    if (deviceId !== null) {
      item.deviceIds.push(deviceId);
      item.deviceCount++;
    }
  }
  return [...result.values()];
}
async function find(db: Reader, groupId: string): Promise<Group> {
  const [group] = await read(db, groupId);
  if (!group) throw new GroupRepositoryError(404, "groupが見つかりません");
  return group;
}
async function lock(tx: Transaction, groupId: string) {
  const [group] = await tx
    .select()
    .from(groups)
    .where(and(eq(groups.groupId, groupId), isNull(groups.deletedAt)))
    .for("update");
  if (!group) throw new GroupRepositoryError(404, "groupが見つかりません");
  return group;
}
async function advance(
  tx: Transaction,
  groupId: string,
  input: UpdateGroup = {},
) {
  await tx
    .update(groups)
    .set({
      ...input,
      revision: sql`${groups.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(groups.groupId, groupId));
}
export function createGroupRepository(db: Database): GroupRepository {
  return {
    list: () => read(db),
    find: (id) => find(db, id),
    create: (input) =>
      db.transaction(async (tx) => {
        const groupId = randomUUID();
        await tx.insert(groups).values({ groupId, ...input });
        await appendAudit(tx, {
          action: "group.created",
          targetKind: "group",
          targetId: groupId,
          groupId,
          metadata: { afterName: input.name },
        });
        return find(tx, groupId);
      }),
    update: (id, input) =>
      db.transaction(async (tx) => {
        const before = await lock(tx, id);
        await advance(tx, id, input);
        await appendAudit(tx, {
          action: "group.updated",
          targetKind: "group",
          targetId: id,
          groupId: id,
          metadata: {
            beforeName: before.name,
            afterName: input.name ?? before.name,
            descriptionChanged:
              input.description !== undefined &&
              input.description !== before.description,
          },
        });
        return find(tx, id);
      }),
    remove: (id) =>
      db.transaction(async (tx) => {
        await lock(tx, id);
        const now = new Date();
        await tx
          .update(groups)
          .set({
            deletedAt: now,
            updatedAt: now,
            revision: sql`${groups.revision} + 1`,
          })
          .where(eq(groups.groupId, id));
        await appendAudit(tx, {
          action: "group.deleted",
          targetKind: "group",
          targetId: id,
          groupId: id,
        });
      }),
    addMember: (id, deviceId) =>
      db.transaction(async (tx) => {
        await lock(tx, id);
        const [device] = await tx
          .select({ deviceId: devices.deviceId })
          .from(devices)
          .where(eq(devices.deviceId, deviceId))
          .for("key share");
        if (!device)
          throw new GroupRepositoryError(404, "deviceが見つかりません");
        const inserted = await tx
          .insert(groupMemberships)
          .values({ groupId: id, deviceId })
          .onConflictDoNothing()
          .returning();
        if (!inserted.length)
          throw new GroupRepositoryError(409, "deviceは登録済みです");
        await advance(tx, id);
        await appendAudit(tx, {
          action: "membership.added",
          targetKind: "group",
          targetId: id,
          groupId: id,
          metadata: { memberDeviceId: deviceId },
        });
        return find(tx, id);
      }),
    removeMember: (id, deviceId) =>
      db.transaction(async (tx) => {
        await lock(tx, id);
        const removed = await tx
          .delete(groupMemberships)
          .where(
            and(
              eq(groupMemberships.groupId, id),
              eq(groupMemberships.deviceId, deviceId),
            ),
          )
          .returning();
        if (!removed.length)
          throw new GroupRepositoryError(404, "membershipが見つかりません");
        await advance(tx, id);
        await appendAudit(tx, {
          action: "membership.removed",
          targetKind: "group",
          targetId: id,
          groupId: id,
          metadata: { memberDeviceId: deviceId },
        });
        return find(tx, id);
      }),
  };
}
