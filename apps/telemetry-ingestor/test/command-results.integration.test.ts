import {
  commands,
  commandExecutionEvents,
  commandOutbox,
  createDatabase,
  devices,
} from "@drone-fleet/database";
import type { CommandAcknowledgementMessage } from "@drone-fleet/protocol";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connectAsync } from "mqtt";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createCommandAcknowledgementRepository } from "../src/acknowledgement.js";
import { createTelemetryRepository } from "../src/repository.js";
import { createDeviceStatusRepository } from "../src/status.js";
import { startTelemetryIngestor } from "../src/app.js";
import { startSimulator } from "../../simulator/src/simulator.js";
import { createCommandRepository } from "../../api/src/command-repository.js";
import { createCommandService } from "../../api/src/command-service.js";
const enabled = process.env.DATABASE_INTEGRATION === "true";
const database = enabled ? createDatabase() : undefined;
const deviceId = "integration-command-results",
  ids = [deviceId, `${deviceId}-other`];
const exec = promisify(execFile);
function configured() {
  if (!database) throw new Error("integration database required");
  return database;
}
async function command() {
  const { db } = configured(),
    commandId = randomUUID();
  await db.insert(commands).values({
    commandId,
    deviceId,
    type: "RETURN_HOME",
    createdAt: new Date("2026-10-14T00:00:00Z"),
    expiresAt: new Date("2026-10-14T00:00:30Z"),
  });
  return commandId;
}
function notification(
  commandId: string,
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "UNCERTAIN",
  time = "2026-10-14T00:00:02.000Z",
): CommandAcknowledgementMessage {
  return {
    schemaVersion: 3,
    commandId,
    deviceId,
    status,
    timestamp: time,
    startedAt: "2026-10-14T00:00:01.000Z",
  };
}
async function row(id: string) {
  return (
    await configured()
      .db.select()
      .from(commands)
      .where(eq(commands.commandId, id))
  )[0]!;
}
async function cleanup() {
  await configured().db.delete(commands).where(inArray(commands.deviceId, ids));
  await configured().db.delete(devices).where(inArray(devices.deviceId, ids));
}
describe.skipIf(!enabled)("command execution persistence", () => {
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
  it("stores result/device/server times without fabricating a receipt and keeps them on duplicate receipt", async () => {
    const id = await command(),
      repo = createCommandAcknowledgementRepository(configured().db),
      receivedAt = new Date("2026-10-14T00:00:03Z");
    expect(
      await repo.acknowledge(notification(id, "SUCCEEDED"), receivedAt),
    ).toBe("updated");
    expect(await row(id)).toMatchObject({
      status: "PENDING",
      executionStatus: "SUCCEEDED",
      acknowledgementReceivedAt: null,
      executionStartedAt: new Date("2026-10-14T00:00:01Z"),
      executionResultAt: new Date("2026-10-14T00:00:02Z"),
      executionResultReceivedAt: receivedAt,
    });
    expect(
      await repo.acknowledge(
        notification(id, "SUCCEEDED"),
        new Date("2026-10-14T00:00:04Z"),
      ),
    ).toBe("duplicate");
    await repo.acknowledge(
      {
        schemaVersion: 3,
        commandId: id,
        deviceId,
        status: "ACKNOWLEDGED",
        timestamp: "2026-10-14T00:00:01Z",
      },
      new Date("2026-10-14T00:00:05Z"),
    );
    expect(await row(id)).toMatchObject({
      status: "ACKNOWLEDGED",
      executionStatus: "SUCCEEDED",
      executionResultReceivedAt: receivedAt,
    });
    expect(
      await configured()
        .db.select()
        .from(commandExecutionEvents)
        .where(eq(commandExecutionEvents.commandId, id)),
    ).toHaveLength(1);
  });
  it("records conflicting terminal results and ignores a late RUNNING", async () => {
    const id = await command(),
      repo = createCommandAcknowledgementRepository(configured().db);
    await repo.acknowledge(notification(id, "SUCCEEDED"), new Date());
    expect(await repo.acknowledge(notification(id, "FAILED"), new Date())).toBe(
      "conflict",
    );
    expect(
      await repo.acknowledge(notification(id, "RUNNING"), new Date()),
    ).toBe("duplicate");
    expect((await row(id)).executionStatus).toBe("SUCCEEDED");
    expect(
      (
        await configured()
          .db.select()
          .from(commandExecutionEvents)
          .where(eq(commandExecutionEvents.commandId, id))
      ).map((event) => event.disposition),
    ).toEqual(["applied", "conflict", "ignored"]);
  });
  it("resolves UNCERTAIN with a reliable terminal result and preserves the earlier event", async () => {
    const id = await command(),
      repo = createCommandAcknowledgementRepository(configured().db);
    await repo.acknowledge(
      notification(id, "UNCERTAIN", "2026-10-14T00:00:03.000Z"),
      new Date(),
    );
    expect(
      await repo.acknowledge(notification(id, "RUNNING"), new Date()),
    ).toBe("duplicate");
    expect(
      await repo.acknowledge(notification(id, "SUCCEEDED"), new Date()),
    ).toBe("updated");
    expect((await row(id)).executionStatus).toBe("SUCCEEDED");
    expect(
      await configured()
        .db.select()
        .from(commandExecutionEvents)
        .where(eq(commandExecutionEvents.commandId, id)),
    ).toHaveLength(3);
  });
  it("keeps expiry and execution contradictions as conflicts in either arrival order", async () => {
    const repo = createCommandAcknowledgementRepository(configured().db);
    for (const expiredFirst of [true, false]) {
      const id = await command();
      const expiry: CommandAcknowledgementMessage = {
        schemaVersion: 2,
        commandId: id,
        deviceId,
        status: "REJECTED_EXPIRED",
        timestamp: "2026-10-14T00:00:30Z",
      };
      await repo.acknowledge(
        expiredFirst ? expiry : notification(id, "RUNNING"),
        new Date(),
      );
      expect(
        await repo.acknowledge(
          expiredFirst ? notification(id, "RUNNING") : expiry,
          new Date(),
        ),
      ).toBe("conflict");
      expect(await row(id)).toMatchObject(
        expiredFirst
          ? { status: "EXPIRED", executionStatus: "NOT_REPORTED" }
          : { status: "PENDING", executionStatus: "RUNNING" },
      );
    }
  });
  it("rejects invalid starts, mismatched devices, legacy commands and unknown command IDs", async () => {
    const id = await command(),
      repo = createCommandAcknowledgementRepository(configured().db);
    expect(
      await repo.acknowledge(
        {
          ...notification(id, "SUCCEEDED"),
          startedAt: "2026-10-14T00:00:30Z",
          timestamp: "2026-10-14T00:00:31Z",
        } as CommandAcknowledgementMessage,
        new Date(),
      ),
    ).toBe("conflict");
    expect(
      await repo.acknowledge(
        { ...notification(id, "RUNNING"), deviceId: ids[1]! },
        new Date(),
      ),
    ).toBe("not_found");
    expect(
      await repo.acknowledge(notification(randomUUID(), "RUNNING"), new Date()),
    ).toBe("not_found");
    await configured()
      .db.update(commands)
      .set({ expiresAt: null })
      .where(eq(commands.commandId, id));
    expect(
      await repo.acknowledge(notification(id, "RUNNING"), new Date()),
    ).toBe("not_found");
  });
  it("serializes concurrent opposing results and enforces execution constraints", async () => {
    const id = await command(),
      { db } = configured(),
      repo = createCommandAcknowledgementRepository(db);
    const outcomes = await Promise.all([
      repo.acknowledge(notification(id, "SUCCEEDED"), new Date()),
      repo.acknowledge(notification(id, "FAILED"), new Date()),
    ]);
    expect(outcomes.sort()).toEqual(["conflict", "updated"]);
    await expect(
      db
        .update(commands)
        .set({ executionStatus: "invalid" })
        .where(eq(commands.commandId, id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(commands)
        .set({ executionStartedAt: null })
        .where(eq(commands.commandId, id)),
    ).rejects.toThrow();
  });
  it("runs RETURN_HOME and REBOOT through real MQTT, and replays a lost result without executing again", async () => {
    const { db } = configured(),
      directory = mkdtempSync(join(tmpdir(), "drone-command-results-"));
    const container = `drone-command-results-${process.pid}`;
    let created = false,
      simulator: Awaited<ReturnType<typeof startSimulator>> | undefined,
      ingestor: Awaited<ReturnType<typeof startTelemetryIngestor>> | undefined,
      observer: Awaited<ReturnType<typeof connectAsync>> | undefined;
    try {
      await exec("docker", [
        "run",
        "-d",
        "--name",
        container,
        "-p",
        "127.0.0.1::1883",
        "-v",
        `${fileURLToPath(new URL("../../../infra/local/mosquitto/config/mosquitto.conf", import.meta.url))}:/mosquitto/config/mosquitto.conf:ro`,
        "eclipse-mosquitto:2.0.22",
      ]);
      created = true;
      const { stdout } = await exec("docker", ["port", container, "1883/tcp"]);
      const url = `mqtt://127.0.0.1:${stdout.trim().split(":").at(-1)}`;
      observer = await connectAsync(url, { connectTimeout: 5000 });
      const seen: Array<{
        status: string;
        schemaVersion: number;
        qos: number;
        retain: boolean;
      }> = [];
      observer.on("message", (topic, payload, packet) => {
        if (topic.endsWith("/command-acks"))
          seen.push({
            ...JSON.parse(payload.toString()),
            qos: packet.qos,
            retain: packet.retain,
          });
      });
      await observer.subscribeAsync(
        `fleet/v1/devices/${deviceId}/command-acks`,
        { qos: 1 },
      );
      let dropSuccess = true;
      let droppedSuccess = 0;
      const repository = createCommandAcknowledgementRepository(db);
      ingestor = await startTelemetryIngestor(
        {
          mqttTransport: { type: "local", url },
          offlineTimeoutMs: 15000,
          telemetryBatchSize: 1,
          telemetryFlushIntervalMs: 10,
          telemetryMaxBufferSize: 100,
        },
        createTelemetryRepository(db),
        createDeviceStatusRepository(db),
        {
          acknowledge: (message, time) => {
            if (
              message.schemaVersion === 3 &&
              message.status === "SUCCEEDED" &&
              dropSuccess
            ) {
              droppedSuccess++;
              return Promise.resolve("duplicate" as const);
            }
            return repository.acknowledge(message, time);
          },
        },
        { warn: vi.fn(), error: vi.fn() },
      );
      simulator = await startSimulator({
        deviceId,
        mqttUrl: url,
        simulationSeed: "result",
        telemetryIntervalMs: 200,
        telemetryBufferPath: join(directory, "buffer.sqlite"),
        telemetryBufferMaxRows: 1000,
        telemetryBufferMaxBytes: 1000000,
        telemetryReplayIntervalMs: 50,
        telemetryRetryBaseMs: 100,
        telemetryRetryMaxMs: 200,
        telemetryPublishTimeoutMs: 1000,
      });
      const service = createCommandService(createCommandRepository(db));
      const accepted = await service.send(deviceId, "RETURN_HOME");
      const outbox = (
        await db
          .select()
          .from(commandOutbox)
          .where(eq(commandOutbox.commandId, accepted.commandId))
      )[0]!;
      await observer.publishAsync(outbox.topic, outbox.payload, {
        qos: 1,
        retain: false,
      });
      await vi.waitFor(
        async () =>
          expect((await row(accepted.commandId)).executionStatus).toBe(
            "RUNNING",
          ),
        { timeout: 5000 },
      );
      await vi.waitFor(
        () =>
          expect(seen.some((item) => item.status === "SUCCEEDED")).toBe(true),
        { timeout: 15000 },
      );
      expect((await row(accepted.commandId)).executionStatus).toBe("RUNNING"); // PUBACKだけではDB結果保存を保証しない。
      await vi.waitFor(() => expect(droppedSuccess).toBeGreaterThan(0), {
        timeout: 5000,
      });
      const runs = seen.filter((item) => item.status === "RUNNING").length;
      dropSuccess = false;
      await observer.publishAsync(outbox.topic, outbox.payload, {
        qos: 1,
        retain: false,
      });
      await vi.waitFor(
        async () =>
          expect((await row(accepted.commandId)).executionStatus).toBe(
            "SUCCEEDED",
          ),
        { timeout: 5000 },
      );
      expect(seen.filter((item) => item.status === "RUNNING")).toHaveLength(
        runs,
      );
      const reboot = await service.send(deviceId, "REBOOT");
      const rebootOutbox = (
        await db
          .select()
          .from(commandOutbox)
          .where(eq(commandOutbox.commandId, reboot.commandId))
      )[0]!;
      await observer.publishAsync(rebootOutbox.topic, rebootOutbox.payload, {
        qos: 1,
        retain: false,
      });
      await vi.waitFor(
        async () =>
          expect((await row(reboot.commandId)).executionStatus).toBe(
            "SUCCEEDED",
          ),
        { timeout: 5000 },
      );
      expect(seen.every((item) => item.qos === 1 && !item.retain)).toBe(true);
    } finally {
      await simulator?.shutdown();
      await ingestor?.shutdown();
      await observer?.endAsync(true);
      if (created) await exec("docker", ["rm", "-fv", container]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
