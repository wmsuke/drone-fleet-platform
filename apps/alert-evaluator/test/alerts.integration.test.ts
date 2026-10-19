import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  alerts,
  alertEvaluationStates,
  devices,
  telemetry,
  commands,
  groups,
  fleetOperations,
  fleetOperationTargets,
  deviceOnlineObservations,
} from "@drone-fleet/database";
import { createTelemetryRepository } from "../../telemetry-ingestor/src/repository.js";
import { createDeviceStatusRepository } from "../../telemetry-ingestor/src/status.js";
import { createCommandAcknowledgementRepository } from "../../telemetry-ingestor/src/acknowledgement.js";
import { createAlertRepository } from "../src/repository.js";
import { loadAlertPolicy } from "../src/config.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const id = "integration-alert-device";
const base = new Date("2026-10-19T00:00:00Z").getTime();
const at = (ms: number) => new Date(base + ms);
const policy = loadAlertPolicy({});
const session = randomUUID();
const commandIds: string[] = [],
  groupIds: string[] = [];
function configured() {
  if (!database) throw new Error("missing DB");
  return database;
}
function repo() {
  return createAlertRepository(configured().db, policy);
}
async function cleanup() {
  const { db, client } = configured();
  await client.unsafe("DROP TRIGGER IF EXISTS issue142_fail_alert ON alerts");
  await client.unsafe("DROP FUNCTION IF EXISTS issue142_fail_alert()");
  await client.unsafe(
    "DROP TRIGGER IF EXISTS issue142_fail_checkpoint ON alert_evaluation_states",
  );
  await client.unsafe("DROP FUNCTION IF EXISTS issue142_fail_checkpoint()");
  await db.delete(alerts).where(eq(alerts.deviceId, id));
  await db
    .delete(alertEvaluationStates)
    .where(like(alertEvaluationStates.targetKey, `device:${id}%`));
  if (commandIds.length) {
    await db.delete(alertEvaluationStates).where(
      inArray(
        alertEvaluationStates.targetKey,
        commandIds.map((c) => `command:${c}`),
      ),
    );
    await db
      .delete(fleetOperationTargets)
      .where(inArray(fleetOperationTargets.commandId, commandIds));
    await db
      .delete(commands)
      .where(inArray(commands.commandId, commandIds.splice(0)));
  }
  if (groupIds.length) {
    await db
      .delete(fleetOperations)
      .where(inArray(fleetOperations.groupId, groupIds));
    await db.delete(groups).where(inArray(groups.groupId, groupIds.splice(0)));
  }
  await db.delete(devices).where(eq(devices.deviceId, id));
}
async function sample(
  ms: number,
  battery: number,
  options: {
    retained?: boolean;
    session?: string;
    sequence?: number;
    deviceMs?: number;
  } = {},
) {
  return createTelemetryRepository(configured().db).saveBatch([
    {
      message: {
        schemaVersion: 2,
        deviceId: id,
        sessionId: options.session ?? session,
        sequence: options.sequence ?? ms,
        timestamp: at(options.deviceMs ?? ms).toISOString(),
        payload: {
          battery,
          latitude: 35,
          longitude: 139,
          altitude: 0,
          temperature: 25,
          status: "IDLE",
        },
      },
      receivedAt: at(ms),
      isRetained: options.retained ?? false,
    },
  ]);
}
async function status(
  ms: number,
  online: boolean,
  retained = false,
  deviceMs = ms,
) {
  return createDeviceStatusRepository(configured().db).saveStatus(
    {
      schemaVersion: 1,
      deviceId: id,
      timestamp: at(deviceMs).toISOString(),
      payload: online
        ? { status: "ONLINE", reason: "CONNECTED" }
        : { status: "OFFLINE", reason: "CONNECTION_LOST" },
    },
    at(ms),
    retained,
  );
}
async function series(from: number, to: number, battery: number) {
  for (let t = from; t <= to; t += 5000) {
    await sample(t, battery);
    await repo().evaluateDevice(id, at(t));
  }
}
async function stored(kind?: string) {
  return configured()
    .db.select()
    .from(alerts)
    .where(
      and(eq(alerts.deviceId, id), kind ? eq(alerts.kind, kind) : undefined),
    )
    .orderBy(alerts.occurredAt);
}
async function command(
  statusValue: "PENDING" | "FAILED" | "TIMED_OUT" | "EXPIRED" = "PENDING",
) {
  const commandId = randomUUID();
  commandIds.push(commandId);
  await configured()
    .db.insert(commands)
    .values({
      commandId,
      deviceId: id,
      type: "RETURN_HOME",
      status: statusValue,
      createdAt: at(0),
      expiresAt: at(30_000),
      ...(statusValue === "EXPIRED" ? { expiredAt: at(30_000) } : {}),
    });
  return commandId;
}
async function execution(
  commandId: string,
  result: "RUNNING" | "SUCCEEDED" | "FAILED" | "UNCERTAIN",
  received = 130_000,
) {
  return createCommandAcknowledgementRepository(configured().db).acknowledge(
    {
      schemaVersion: 3,
      deviceId: id,
      commandId,
      status: result,
      startedAt: at(1000).toISOString(),
      timestamp: at(result === "RUNNING" ? 1000 : 10_000).toISOString(),
    },
    at(received),
  );
}
describe.skipIf(!enabled)("durable alert evaluation", () => {
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
      .values({
        deviceId: id,
        connectionStatus: "ONLINE",
        createdAt: at(0),
        updatedAt: at(0),
        lastReceivedAt: at(0),
        connectionChangedAt: at(0),
        connectionRevision: 1,
      });
  });
  afterAll(async () => {
    await cleanup();
    await configured().client.end();
  });
  it("creates one alert across repeated and concurrent evaluators, and keeps occurrence time and acknowledgement separate", async () => {
    await series(0, 25_000, 20);
    await sample(30_000, 20);
    const results = await Promise.all([
      repo().evaluateDevice(id, at(30_000)),
      repo().evaluateDevice(id, at(30_000)),
    ]);
    expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(1);
    const [first] = await stored("LOW_BATTERY");
    expect(first).toMatchObject({
      status: "ACTIVE",
      severity: "warning",
      occurredAt: at(30_000),
      acknowledgedAt: null,
    });
    await configured()
      .db.update(alerts)
      .set({ acknowledgedAt: at(31_000), acknowledgedActorKind: "anonymous" })
      .where(eq(alerts.alertId, first!.alertId));
    await sample(35_000, 19);
    await repo().evaluateDevice(id, at(35_000));
    expect((await stored("LOW_BATTERY"))[0]).toMatchObject({
      alertId: first!.alertId,
      occurredAt: first!.occurredAt,
      lastObservedAt: at(35_000),
      acknowledgedAt: at(31_000),
      status: "ACTIVE",
    });
    const replay = await repo().evaluateDevice(id, at(35_000));
    expect(replay).toEqual({ created: 0, updated: 0, resolved: 0 });
  });
  it("holds hysteresis, recovers only on sustained valid samples and records a new later episode", async () => {
    await series(0, 30_000, 20);
    await series(35_000, 65_000, 24);
    expect((await stored("LOW_BATTERY"))[0]!.status).toBe("ACTIVE");
    await series(70_000, 100_000, 25);
    expect((await stored("LOW_BATTERY"))[0]).toMatchObject({
      status: "RESOLVED",
      resolvedAt: at(100_000),
    });
    await series(105_000, 135_000, 20);
    expect((await stored("LOW_BATTERY")).map((a) => a.status)).toEqual([
      "RESOLVED",
      "ACTIVE",
    ]);
  });
  it("preserves timers across repository restart and replays only fresh unprocessed facts", async () => {
    await series(0, 15_000, 20);
    await sample(20_000, 20);
    await sample(25_000, 20);
    await sample(30_000, 20);
    expect((await repo().evaluateDevice(id, at(30_000))).created).toBe(1);
    expect(await repo().evaluateDevice(id, at(30_000))).toEqual({
      created: 0,
      updated: 0,
      resolved: 0,
    });
    expect(await stored("LOW_BATTERY")).toHaveLength(1);
  });
  it("does not falsely recover from retained, duplicate, old buffers or cross-session clock rollback", async () => {
    await series(0, 30_000, 20);
    await sample(35_000, 99, { retained: true });
    await sample(40_000, 99, { deviceMs: 0, session: randomUUID() });
    await sample(45_000, 20, { deviceMs: 30_000, sequence: 30_000 });
    await repo().evaluateDevice(id, at(45_000));
    await repo().evaluateDevice(id, at(70_000));
    expect((await stored("LOW_BATTERY"))[0]!.status).toBe("ACTIVE");
    await series(75_000, 100_000, 99);
    expect((await stored("LOW_BATTERY"))[0]!.status).toBe("ACTIVE");
    await sample(105_000, 99);
    await repo().evaluateDevice(id, at(105_000));
    expect((await stored("LOW_BATTERY"))[0]!.status).toBe("RESOLVED");
  });
  it("detects OFFLINE from the actual liveness transition, not last reception; retained ONLINE and old replay cannot recover it", async () => {
    const statuses = createDeviceStatusRepository(configured().db);
    await statuses.markTimedOut(at(0), at(15_000));
    await repo().evaluateDevice(id, at(74_999));
    expect(await stored("OFFLINE")).toHaveLength(0);
    await repo().evaluateDevice(id, at(75_000));
    const [first] = await stored("OFFLINE");
    expect(first!.occurredAt).toEqual(at(75_000));
    await status(80_000, true, true);
    await repo().evaluateDevice(id, at(80_000));
    await sample(85_000, 80, { deviceMs: 0 });
    await repo().evaluateDevice(id, at(85_000));
    expect((await stored("OFFLINE"))[0]!.status).toBe("ACTIVE");
    await series(90_000, 120_000, 80);
    expect((await stored("OFFLINE"))[0]).toMatchObject({
      alertId: first!.alertId,
      status: "RESOLVED",
      resolvedAt: at(120_000),
    });
    await status(125_000, false);
    await repo().evaluateDevice(id, at(185_000));
    expect((await stored("OFFLINE")).map((a) => a.status)).toEqual([
      "RESOLVED",
      "ACTIVE",
    ]);
  });
  it("requires new non-retained ONLINE evidence for 30 seconds and records duplicate status only once", async () => {
    await status(1000, false);
    await repo().evaluateDevice(id, at(61_000));
    for (let t = 65_000; t <= 90_000; t += 5000) {
      await status(t, true);
      await status(t + 1, true, false, t);
      await repo().evaluateDevice(id, at(t + 1));
    }
    expect((await stored("OFFLINE"))[0]!.status).toBe("ACTIVE");
    await status(95_000, true);
    await repo().evaluateDevice(id, at(95_000));
    expect((await stored("OFFLINE"))[0]!.status).toBe("RESOLVED");
    expect(
      await configured()
        .db.select()
        .from(deviceOnlineObservations)
        .where(eq(deviceOnlineObservations.deviceId, id)),
    ).toHaveLength(7);
  });
  it("persists short OFFLINE transitions even when evaluator did not run during the interruption", async () => {
    await series(0, 20_000, 20);
    await status(21_000, false);
    await status(22_000, true);
    await series(25_000, 50_000, 20);
    expect(await stored("LOW_BATTERY")).toHaveLength(0);
    await sample(55_000, 20);
    await repo().evaluateDevice(id, at(55_000));
    expect(await stored("LOW_BATTERY")).toHaveLength(1);
  });
  it.each(["FAILED", "TIMED_OUT"] as const)(
    "keeps %s warning until certain success, not just late receipt or RUNNING",
    async (delivery) => {
      const c = await command(delivery);
      await repo().evaluateCommand(c, at(10_000));
      const [first] = await stored("COMMAND_OUTCOME");
      expect(first!.status).toBe("ACTIVE");
      expect(await repo().evaluateCommand(c, at(10_000))).toEqual({
        created: 0,
        updated: 0,
        resolved: 0,
      });
      await execution(c, "RUNNING", 20_000);
      await repo().evaluateCommand(c, at(20_000));
      expect((await stored("COMMAND_OUTCOME"))[0]!.status).toBe("ACTIVE");
      await execution(c, "SUCCEEDED");
      await repo().evaluateCommand(c, at(130_000));
      expect((await stored("COMMAND_OUTCOME"))[0]).toMatchObject({
        alertId: first!.alertId,
        status: "RESOLVED",
        reason: "SUCCEEDED",
      });
      expect((await repo().evaluateCommand(c, at(140_000))).created).toBe(0);
      expect(await stored("COMMAND_OUTCOME")).toHaveLength(1);
    },
  );
  it.each(["FAILED", "EXPIRED"] as const)(
    "does not resolve definitive %s automatically and updates uncertain to definitive failure on the same alert",
    async (kind) => {
      const c = await command(kind === "EXPIRED" ? "EXPIRED" : "PENDING");
      if (kind === "FAILED") {
        await execution(c, "UNCERTAIN", 10_000);
        await repo().evaluateCommand(c, at(10_000));
        await execution(c, "FAILED", 20_000);
      }
      await repo().evaluateCommand(c, at(30_000));
      const [first] = await stored("COMMAND_OUTCOME");
      expect(first!.reason).toBe(
        kind === "EXPIRED" ? "EXPIRED" : "EXECUTION_FAILED",
      );
      expect(await execution(c, "SUCCEEDED")).toBe("conflict");
      await repo().evaluateCommand(c, at(140_000));
      expect((await stored("COMMAND_OUTCOME"))[0]).toMatchObject({
        alertId: first!.alertId,
        status: "ACTIVE",
      });
    },
  );
  it("uses stored operation deadline, while single-device commands use the configured deadline", async () => {
    const single = await command(),
      grouped = await command();
    const groupId = randomUUID(),
      operationId = randomUUID();
    groupIds.push(groupId);
    await configured().db.insert(groups).values({ groupId, name: "試験隊" });
    await configured()
      .db.insert(fleetOperations)
      .values({
        operationId,
        groupId,
        groupName: "試験隊",
        groupRevision: 1,
        type: "RETURN_HOME",
        idempotencyScope: "anonymous",
        idempotencyKey: operationId,
        targetCount: 1,
        createdAt: at(0),
        expiresAt: at(30_000),
        resultDeadline: at(200_000),
      });
    await configured()
      .db.insert(fleetOperationTargets)
      .values({ operationId, deviceId: id, commandId: grouped });
    await repo().evaluateCommand(single, at(120_000));
    await repo().evaluateCommand(grouped, at(120_000));
    expect((await stored("COMMAND_OUTCOME")).map((a) => a.commandId)).toEqual([
      single,
    ]);
    expect(await repo().commandIds(at(120_000))).toContain(single);
    expect(await repo().commandIds(at(120_000))).not.toContain(grouped);
    await repo().evaluateCommand(grouped, at(200_000));
    expect(await stored("COMMAND_OUTCOME")).toHaveLength(2);
  });
  it("rolls back alert plus checkpoint on failure without rolling back committed telemetry or ACK, then replays successfully", async () => {
    await series(0, 25_000, 20);
    await sample(30_000, 20);
    await configured().client.unsafe(
      `CREATE FUNCTION issue142_fail_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected alert failure'; END $$`,
    );
    await configured().client.unsafe(
      "CREATE TRIGGER issue142_fail_alert BEFORE INSERT ON alerts FOR EACH ROW EXECUTE FUNCTION issue142_fail_alert()",
    );
    await expect(repo().evaluateDevice(id, at(30_000))).rejects.toThrow();
    expect(await stored()).toHaveLength(0);
    const [checkpoint] = await configured()
      .db.select()
      .from(alertEvaluationStates)
      .where(eq(alertEvaluationStates.targetKey, `device:${id}`));
    expect(checkpoint!.evaluatedAt).toEqual(at(25_000));
    expect(
      await configured()
        .db.select()
        .from(telemetry)
        .where(eq(telemetry.deviceId, id)),
    ).toHaveLength(7);
    const c = await command();
    expect(await execution(c, "FAILED", 31_000)).toBe("updated");
    await configured().client.unsafe(
      "DROP TRIGGER issue142_fail_alert ON alerts",
    );
    expect((await repo().evaluateDevice(id, at(30_000))).created).toBe(1);
    expect((await repo().evaluateCommand(c, at(31_000))).created).toBe(1);
    expect(await stored()).toHaveLength(2);
  });
  it("rolls back a newly inserted alert if checkpoint persistence fails after it", async () => {
    await series(0, 25_000, 20);
    await sample(30_000, 20);
    await configured().client.unsafe(
      `CREATE FUNCTION issue142_fail_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$`,
    );
    await configured().client.unsafe(
      "CREATE TRIGGER issue142_fail_checkpoint BEFORE INSERT OR UPDATE ON alert_evaluation_states FOR EACH ROW EXECUTE FUNCTION issue142_fail_checkpoint()",
    );
    await expect(repo().evaluateDevice(id, at(30_000))).rejects.toThrow();
    expect(await stored()).toHaveLength(0);
    const [checkpoint] = await configured()
      .db.select()
      .from(alertEvaluationStates)
      .where(eq(alertEvaluationStates.targetKey, `device:${id}`));
    expect(checkpoint!.evaluatedAt).toEqual(at(25_000));
    await configured().client.unsafe(
      "DROP TRIGGER issue142_fail_checkpoint ON alert_evaluation_states",
    );
    expect((await repo().evaluateDevice(id, at(30_000))).created).toBe(1);
  });
  it("enforces active-key uniqueness and restarts continuity if policy changes", async () => {
    await series(0, 25_000, 20);
    const changed = createAlertRepository(configured().db, {
      ...policy,
      lowBattery: 19,
    });
    await sample(30_000, 19);
    expect((await changed.evaluateDevice(id, at(30_000))).created).toBe(0);
    for (let t = 35_000; t <= 60_000; t += 5000) {
      await sample(t, 19);
      await changed.evaluateDevice(id, at(t));
    }
    const [row] = await stored("LOW_BATTERY");
    expect(row!.parameters.lowBattery).toBe(19);
    await expect(
      configured()
        .db.insert(alerts)
        .values({ ...row!, alertId: randomUUID() }),
    ).rejects.toThrow();
  });
});
