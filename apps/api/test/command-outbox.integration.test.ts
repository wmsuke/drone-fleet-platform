import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  commands,
  devices,
  commandOutbox,
} from "@drone-fleet/database";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createCommandRepository } from "../src/command-repository.js";
import { createCommandOutbox } from "../src/command-outbox.js";

const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
describe.skipIf(!enabled)("durable command outbox", () => {
  const db = database!;
  const deviceId = "integration-outbox";
  const options = { pollMs: 1, baseMs: 100, maxMs: 1000, maxAttempts: 2 };
  let time = new Date("2026-10-13T00:00:00Z");
  const now = () => time;
  const enqueue = (expiresAt = new Date(time.getTime() + 30000)) =>
    createCommandRepository(db.db).createPending({
      commandId: randomUUID(),
      deviceId,
      type: "REBOOT",
      createdAt: time,
      expiresAt,
    });
  const read = async () => (await db.db.select().from(commandOutbox))[0]!;
  beforeAll(async () => {
    await migrate(db.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    await db.db.insert(devices).values({ deviceId }).onConflictDoNothing();
  });
  beforeEach(async () => {
    await db.db.delete(commands).where(eq(commands.deviceId, deviceId));
    time = new Date("2026-10-13T00:00:00Z");
  });
  afterAll(async () => {
    await db.db.delete(commands).where(eq(commands.deviceId, deviceId));
    await db.db.delete(devices).where(eq(devices.deviceId, deviceId));
    await db.client.end();
  });
  it("rolls command creation back when outbox validation fails", async () => {
    await expect(enqueue(new Date(time.getTime() - 1))).rejects.toThrow();
    expect(
      await db.db
        .select()
        .from(commands)
        .where(eq(commands.deviceId, deviceId)),
    ).toHaveLength(0);
    expect(await db.db.select().from(commandOutbox)).toHaveLength(0);
  });
  it("resumes the same payload and ID in a new worker after a failed attempt", async () => {
    const command = await enqueue();
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("broker offline"))
      .mockResolvedValue(undefined);
    await createCommandOutbox(
      db.client,
      publish,
      options,
      now,
      () => 0,
    ).runOnce();
    expect(await read()).toMatchObject({
      attempts: 1,
      failures: 1,
      state: "PENDING",
    });
    time = new Date(time.getTime() + 100);
    const restarted = createDatabase();
    try {
      await createCommandOutbox(
        restarted.client,
        publish,
        options,
        now,
        () => 0,
      ).runOnce();
    } finally {
      await restarted.client.end();
    }
    expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
    expect(JSON.parse(publish.mock.calls[1][1]).commandId).toBe(
      command!.commandId,
    );
    expect(await read()).toMatchObject({
      attempts: 2,
      failures: 1,
      state: "WAITING_ACK",
    });
    expect(
      await createCommandOutbox(db.client, publish, options, now).status(),
    ).toMatchObject({ backlog: 1, attempts: 2, failures: 1 });
  });
  it("excludes concurrent workers and commits attempts before delivery", async () => {
    await enqueue();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = vi.fn(() => blocked);
    const first = createCommandOutbox(
      db.client,
      publish,
      options,
      now,
    ).runOnce();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect((await read()).attempts).toBe(1);
    time = new Date(time.getTime() + 2000);
    await createCommandOutbox(db.client, publish, options, now).runOnce();
    expect(publish).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
  it("does not block an ACK during publish or overwrite it", async () => {
    const command = await enqueue();
    const publish = vi.fn(async () => {
      await db.db
        .update(commands)
        .set({ status: "ACKNOWLEDGED", acknowledgementReceivedAt: time })
        .where(eq(commands.commandId, command!.commandId));
    });
    const worker = createCommandOutbox(db.client, publish, options, now);
    await worker.runOnce();
    time = new Date(time.getTime() + 10000);
    await worker.runOnce();
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await read()).state).toBe("ACKNOWLEDGED");
  });
  it("expires an unattempted command without publishing", async () => {
    await enqueue();
    time = new Date(time.getTime() + 30000);
    const publish = vi.fn();
    await createCommandOutbox(db.client, publish, options, now).runOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ attempts: 0, state: "EXPIRED" });
  });
  it("leaves historical commands outside the outbox", async () => {
    await createCommandRepository(db.db).createPending({
      commandId: randomUUID(),
      deviceId,
      type: "REBOOT",
      createdAt: time,
    });
    const publish = vi.fn();
    await createCommandOutbox(db.client, publish, options, now).runOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(await db.db.select().from(commandOutbox)).toHaveLength(0);
  });
  it("stops retrying after an ACK committed between workers", async () => {
    const command = await enqueue();
    const publish = vi.fn(async () => undefined);
    await createCommandOutbox(db.client, publish, options, now).runOnce();
    await db.db
      .update(commands)
      .set({ status: "ACKNOWLEDGED", acknowledgementReceivedAt: time })
      .where(eq(commands.commandId, command!.commandId));
    time = new Date(time.getTime() + 2000);
    await createCommandOutbox(db.client, publish, options, now).runOnce();
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await read()).state).toBe("ACKNOWLEDGED");
  });
  it("fails at the maximum attempt count", async () => {
    await enqueue();
    const publish = vi.fn(async () => {
      throw new Error("offline");
    });
    const worker = createCommandOutbox(
      db.client,
      publish,
      options,
      now,
      () => 0,
    );
    await worker.runOnce();
    time = new Date(time.getTime() + 1000);
    await worker.runOnce();
    time = new Date(time.getTime() + 1000);
    await worker.runOnce();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(await read()).toMatchObject({
      attempts: 2,
      failures: 2,
      state: "FAILED",
    });
  });
  it("uses TIMED_OUT, not EXPIRED, after uncertain delivery", async () => {
    await enqueue();
    const publish = vi.fn(async () => undefined);
    const worker = createCommandOutbox(db.client, publish, options, now);
    await worker.runOnce();
    time = new Date(time.getTime() + 30000);
    await worker.runOnce();
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await read()).state).toBe("TIMED_OUT");
  });
});
