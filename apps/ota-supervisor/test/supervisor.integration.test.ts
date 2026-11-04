import { afterEach, describe, expect, it, vi } from "vitest";
import { rm, readFile, writeFile, open } from "node:fs/promises";
import { randomUUID, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { canonical } from "@drone-fleet/releases";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { bootstrap, Supervisor } from "../src/supervisor.js";
import { stageArtifact, atomicWrite } from "../src/artifacts.js";
import { Journal } from "../src/journal.js";
import { Broker, fixture, applyRequest, identity, pair } from "./support.js";

const enabled = process.env.OTA_DEVICE_INTEGRATION === "true";
describe.skipIf(!enabled)("real Linux Node 22 application OTA", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let supervisor: Supervisor | undefined;
  let broker: Broker;
  async function setup() {
    f = await fixture(true);
    await bootstrap(f.config, identity(f.baseline));
    broker = new Broker();
    supervisor = new Supervisor(f.config, broker.client());
    await supervisor.start();
    return supervisor;
  }
  async function until(fn: () => boolean, timeout = 10000) {
    const end = Date.now() + timeout;
    while (!fn()) {
      if (Date.now() > end) throw new Error("condition timed out");
      await delay(25);
    }
  }
  async function normal(type: "REBOOT" | "RETURN_HOME") {
    const commandId = randomUUID();
    const now = Date.now();
    broker.emit(
      "message",
      "fleet/v1/devices/ota-test/commands",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          deviceId: "ota-test",
          commandId,
          type,
          timestamp: new Date(now).toISOString(),
          expiresAt: new Date(now + 30000).toISOString(),
        }),
      ),
      { retain: false, qos: 1 },
    );
    await until(
      () =>
        broker.messages.some(
          (m) =>
            m.payload.commandId === commandId &&
            m.payload.status === "SUCCEEDED",
        ),
      15000,
    );
  }
  afterEach(async () => {
    await supervisor?.close();
    supervisor = undefined;
    if (f) {
      await new Promise<void>((resolve) => f.server.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("keeps a challenged failure terminal while an observation is in flight", async () => {
    const app = await setup();
    await normal("RETURN_HOME");
    const request = applyRequest(f.candidate);
    await app.handle(request);
    await until(() => app.journal.read().health?.count === 1, 30000);
    const inspect = app.child.inspect.bind(app.child);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inspecting = 0;
    // 次のobserveと定期INVENTORYの両方を待たせ、QUERYだけに一時異常を返す。
    const heldInspection = async (...args: Parameters<typeof inspect>) => {
      const healthy = await inspect(...args);
      inspecting++;
      await barrier;
      return healthy;
    };
    const spy = vi
      .spyOn(app.child, "inspect")
      .mockImplementationOnce(heldInspection)
      .mockImplementationOnce(heldInspection);
    try {
      await until(() => inspecting === 2);
      expect(app.journal.read()).toMatchObject({
        phase: "HEALTH_CHECKING",
        health: { count: 1 },
      });
      spy.mockImplementationOnce(async (...args) => ({
        ...(await inspect(...args)),
        sqlite: false,
      }));
      const { purpose, ...queryBase } = request;
      expect(purpose).toBe("APPLY");
      const now = Date.now();
      await app.handle({
        ...queryBase,
        type: "QUERY_STATE",
        commandId: randomUUID(),
        applyCommandId: request.commandId,
        challengeId: randomUUID(),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 15000).toISOString(),
        resultDeadline: new Date(now + 15000).toISOString(),
      });
      expect(app.journal.events().at(-1)).toMatchObject({
        type: "HEALTH",
        checks: { sqlite: "FAILED" },
      });
      expect((await inspect("HEALTH", request.fence)).sqlite).toBe(true);
      release();
      await app.wait();
      expect(app.journal.read()).toMatchObject({
        phase: "FAILED",
        fault: "HEALTH_FAILED",
        health: { count: 1 },
      });
      expect(
        app.journal
          .events()
          .some(
            (event) => event.type === "PROGRESS" && event.state === "APPLIED",
          ),
      ).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  }, 100000);
  it.each(["APPLIED", "HEALTH_CHECKING"] as const)(
    "runs a signed bundle and rolls back after a challenged health failure during %s",
    async (phase) => {
      const app = await setup();
      const before = await app.child.inspect("HEALTH", "0");
      expect(before.behavior).toBe("baseline");
      const denied = spawnSync(
        process.execPath,
        [
          "-e",
          `require('node:fs').readFileSync(${JSON.stringify(join(f.config.root, "private/journal.sqlite"))})`,
        ],
        { uid: 10001, gid: 10001, stdio: "ignore" },
      );
      expect(denied.status).not.toBe(0);
      const firstTelemetry = broker.messages.find((m) =>
        m.topic.endsWith("/telemetry"),
      )!.payload as { sessionId: string; payload: { temperature: number } };
      await normal("REBOOT");
      await normal("RETURN_HOME");
      const request = applyRequest(f.candidate);
      await app.handle(request);
      await expect(
        app.handle({
          ...request,
          commandId: randomUUID(),
          attemptId: randomUUID(),
          fence: "2",
        }),
      ).rejects.toThrow("DEVICE_BUSY");
      await app.wait();
      expect(app.journal.read()).toMatchObject({
        phase: "APPLIED",
        active: f.candidate,
        knownGood: f.baseline,
        health: { count: 13 },
      });
      const after = await app.child.inspect("HEALTH", "1");
      expect(after.behavior).toBe("updated");
      expect(after.bootId).not.toBe(before.bootId);
      expect(after.version).toBe("0.2.0");
      expect(after.sqlite).toBe(true);
      const newTelemetry = broker.messages.find(
        (m) =>
          m.topic.endsWith("/telemetry") &&
          m.payload.sequence === 0 &&
          m.payload.sessionId !== firstTelemetry.sessionId,
      )!.payload as { payload: { temperature: number } };
      expect(
        newTelemetry.payload.temperature - firstTelemetry.payload.temperature,
      ).toBeCloseTo(4);
      const { purpose, ...queryBase } = request;
      expect(purpose).toBe("APPLY");
      const now = Date.now();
      await app.handle({
        ...queryBase,
        type: "QUERY_STATE",
        commandId: randomUUID(),
        applyCommandId: request.commandId,
        challengeId: randomUUID(),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 15000).toISOString(),
        resultDeadline: new Date(now + 15000).toISOString(),
      });
      expect(app.journal.events().at(-1)).toMatchObject({
        type: "HEALTH",
        running: { release: { version: "0.2.0" } },
        checks: { sqlite: "PASSED", eventLoop: "PASSED" },
      });
      expect(
        app.journal
          .events()
          .some(
            (e) =>
              e.type === "VERSION" && e.running.release.version === "0.2.0",
          ),
      ).toBe(true);
      const count = app.journal.events().length;
      await app.handle(request);
      expect(app.journal.events()).toHaveLength(count);
      await expect(
        app.handle({
          ...request,
          release: { ...request.release, buildId: "changed" },
        }),
      ).rejects.toThrow("COMMAND_CONFLICT");
      await app.close();
      supervisor = undefined;
      broker = new Broker();
      supervisor = new Supervisor(f.config, broker.client());
      await supervisor.start();
      expect((await supervisor.child.inspect("HEALTH", "1")).version).toBe(
        "0.2.0",
      );
      await normal("RETURN_HOME");
      // QUERYがlocalの次の標本より先に失敗を観測した場合も予算起点を保存する。
      supervisor.journal.change({ phase });
      broker.receiptEnabled = false;
      await delay(16000);
      const failureTime = Date.now();
      await supervisor.handle({
        ...queryBase,
        type: "QUERY_STATE",
        commandId: randomUUID(),
        applyCommandId: request.commandId,
        challengeId: randomUUID(),
        createdAt: new Date(failureTime).toISOString(),
        expiresAt: new Date(failureTime + 15000).toISOString(),
        resultDeadline: new Date(failureTime + 15000).toISOString(),
      });
      expect(supervisor.journal.read().phase).toBe("FAILED");
      expect(supervisor.journal.events().at(-1)).toMatchObject({
        type: "HEALTH",
        checks: { receipts: "FAILED" },
      });
      broker.receiptEnabled = true;
      const stopTime = Date.now();
      await supervisor.handle({
        ...queryBase,
        type: "STOP_UPDATE",
        commandId: randomUUID(),
        applyCommandId: request.commandId,
        createdAt: new Date(stopTime).toISOString(),
        expiresAt: new Date(stopTime + 30000).toISOString(),
        resultDeadline: new Date(stopTime + 60000).toISOString(),
      });
      // backendの異常停止が追加されても、既知の失敗終端と復旧観測を失わない。
      expect(supervisor.journal.read().phase).toBe("FAILED");
      await normal("RETURN_HOME");
      const observed = await supervisor.child.inspect("HEALTH", "1"),
        budget = supervisor.journal.budget(request.targetId)!;
      const start = Date.now(),
        rollback = {
          ...request,
          purpose: "ROLLBACK" as const,
          release: identity(f.baseline),
          attemptId: randomUUID(),
          commandId: randomUUID(),
          fence: "2",
          createdAt: new Date(start).toISOString(),
          expiresAt: new Date(start + 300000).toISOString(),
          resultDeadline: new Date(start + 600000).toISOString(),
          recovery: {
            recoveryId: randomUUID(),
            previousAttemptId: request.attemptId,
            rootAttemptId: request.attemptId,
            kind: "ROLLBACK" as const,
            detectedAt: budget.detected_at!,
            budgetDeadline: budget.deadline!,
            maxDownloadBytes: 268435456 as const,
          },
        };
      const trust = await readFile(f.config.trustPath, "utf8");
      try {
        await writeFile(f.config.trustPath, JSON.stringify({ keys: [] }));
        await expect(supervisor.handle(rollback)).rejects.toThrow(
          "UNTRUSTED_KEY",
        );
      } finally {
        await writeFile(f.config.trustPath, trust);
      }
      expect(supervisor.journal.budget(request.targetId)!.rollback_used).toBe(
        0,
      );
      await supervisor.handle(rollback);
      await supervisor.wait();
      expect(supervisor.journal.read()).toMatchObject({
        phase: "APPLIED",
        active: f.baseline,
        knownGood: f.baseline,
        health: { count: 13 },
      });
      const restored = await supervisor.child.inspect("HEALTH", "2");
      expect(restored.version).toBe("0.1.0");
      expect(restored.bootId).not.toBe(observed.bootId);
      expect(restored.behavior).toBe("baseline");
      expect(supervisor.journal.budget(request.targetId)).toMatchObject({
        rollback_used: 1,
        bytes: budget.bytes,
        deadline: budget.deadline,
      });
      expect(
        supervisor.journal
          .events()
          .some(
            (e) =>
              e.attemptId === rollback.attemptId &&
              e.type === "VERSION" &&
              e.running.release.releaseId === f.baseline.manifest.releaseId,
          ),
      ).toBe(true);
    },
    200000,
  );
  it.each(["signature", "digest", "compatibility", "capacity"])(
    "keeps the active bundle when %s verification fails",
    async (kind) => {
      const app = await setup();
      if (kind === "capacity") {
        // 論理サイズで端末の512 MiB上限を越える。ホストdiskは埋めない。
        const file = await open(join(f.config.root, "capacity-fixture"), "w");
        try {
          await file.truncate(400 * 1024 * 1024);
        } finally {
          await file.close();
        }
      }
      if (kind === "signature")
        f.candidate.signature = Buffer.alloc(64).toString("base64");
      if (kind === "digest")
        f.archives.set(f.candidate.manifest.digest, Buffer.from("broken"));
      if (kind === "compatibility") f.candidate.manifest.nodeRange = ">=23 <24";
      if (kind === "compatibility")
        f.candidate.signature = sign(
          null,
          Buffer.from(canonical(f.candidate.manifest)),
          pair.privateKey,
        ).toString("base64");
      await app.handle(applyRequest(f.candidate));
      await app.wait();
      expect(app.journal.read().active).toEqual(f.baseline);
      expect(app.journal.read().phase).toBe("FAILED");
      if (kind === "capacity")
        expect(app.journal.events().at(-1)).toMatchObject({
          reason: "CAPACITY_EXCEEDED",
        });
      if (kind === "compatibility")
        expect(app.journal.events().at(-1)).toMatchObject({
          reason: "INCOMPATIBLE_RELEASE",
        });
      expect((await app.child.inspect("HEALTH", "1")).version).toBe("0.1.0");
    },
    15000,
  );
  it("rejects stale fence and refuses update during a running ordinary command", async () => {
    const app = await setup();
    const request = applyRequest(f.candidate);
    broker.emit(
      "message",
      "fleet/v1/devices/ota-test/commands",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          deviceId: "ota-test",
          commandId: randomUUID(),
          type: "RETURN_HOME",
          timestamp: request.createdAt,
          expiresAt: new Date(Date.now() + 30000).toISOString(),
        }),
      ),
      { qos: 1, retain: false },
    );
    await until(() =>
      broker.messages.some((m) => m.payload.status === "RUNNING"),
    );
    await app.handle(request);
    await app.wait();
    expect(app.journal.read().active).toEqual(f.baseline);
    await expect(
      app.handle({
        ...request,
        commandId: randomUUID(),
        attemptId: randomUUID(),
      }),
    ).rejects.toThrow("FENCE_CONFLICT");
  }, 15000);
  it("holds a kernel device lock for the complete process lifetime", async () => {
    f = await fixture();
    const path = join(f.root, "lock");
    const first = spawn(
      "flock",
      [
        "-n",
        "-F",
        path,
        process.execPath,
        "-e",
        "process.stdout.write('ready');setInterval(()=>{},1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve, reject) => {
      first.stdout.once("data", () => resolve());
      first.once("error", reject);
    });
    try {
      const second = spawnSync("flock", [
        "-n",
        "-F",
        path,
        process.execPath,
        "-e",
        "process.exit(0)",
      ]);
      expect(second.status).toBe(1);
    } finally {
      const exited = new Promise<void>((resolve) =>
        first.once("exit", () => resolve()),
      );
      first.kill("SIGTERM");
      await exited;
    }
  });
  it("does not stop the old application without an OTA DB-save receipt", async () => {
    const app = await setup();
    broker.receiptEnabled = false;
    await app.handle(applyRequest(f.candidate));
    await app.wait();
    expect(app.journal.read()).toMatchObject({
      phase: "FAILED",
      active: f.baseline,
    });
    expect((await app.child.inspect("HEALTH", "1")).version).toBe("0.1.0");
    expect(
      app.journal
        .events()
        .some((e) => e.type === "PROGRESS" && e.state === "QUIESCING"),
    ).toBe(false);
  }, 20000);
  it("stops an in-flight download and does not reapply the delayed duplicate after restart", async () => {
    const app = await setup();
    await normal("RETURN_HOME");
    f.faults.holdArchive = true;
    const request = applyRequest(f.candidate);
    await app.handle(request);
    await until(() => f.faults.archiveRequests === 1);
    const { purpose, ...base } = request;
    expect(purpose).toBe("APPLY");
    const now = Date.now();
    await app.handle({
      ...base,
      type: "STOP_UPDATE",
      commandId: randomUUID(),
      applyCommandId: request.commandId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30000).toISOString(),
      resultDeadline: new Date(now + 60000).toISOString(),
    });
    await app.wait();
    expect(app.journal.read()).toMatchObject({
      phase: "STOPPED",
      active: f.baseline,
    });
    await app.close();
    supervisor = undefined;
    broker = new Broker();
    supervisor = new Supervisor(f.config, broker.client());
    await supervisor.start();
    const boot = (await supervisor.child.inspect("HEALTH", "1")).bootId;
    await supervisor.handle(request);
    expect(f.faults.archiveRequests).toBe(1);
    expect((await supervisor.child.inspect("HEALTH", "1")).bootId).toBe(boot);
    expect(
      supervisor.journal.events().filter((e) => e.type === "VERSION"),
    ).toHaveLength(0);
  }, 20000);
  it.each([false, true])(
    "reconciles the atomic switch boundary with new pointer=%s without reapplying",
    async (flipped) => {
      const app = await setup();
      await app.close();
      supervisor = undefined;
      const request = applyRequest(f.candidate);
      await stageArtifact(
        f.config.root,
        f.candidate,
        f.archives.get(f.candidate.manifest.digest)!,
      );
      const journal = new Journal(
        join(f.config.root, "private/journal.sqlite"),
      );
      journal.change({
        apply: request,
        phase: "SWITCHING",
        highestFence: "1",
        candidate: f.candidate,
        from: f.baseline,
      });
      journal.close();
      if (flipped)
        await atomicWrite(
          join(f.config.root, "private/active"),
          f.candidate.manifest.digest,
        );
      broker = new Broker();
      supervisor = new Supervisor(f.config, broker.client());
      await supervisor.start();
      await until(() => supervisor!.journal.read().phase === "HEALTH_CHECKING");
      expect((await supervisor.child.inspect("HEALTH", "1")).behavior).toBe(
        "updated",
      );
      expect(
        await readFile(join(f.config.root, "private/active"), "utf8"),
      ).toBe(f.candidate.manifest.digest);
    },
    15000,
  );
  it.each(["DOWNLOADING", "BOOTING", "APPLIED"] as const)(
    "holds an uncertain child after a supervisor crash at %s",
    async (phase) => {
      const app = await setup();
      await app.close();
      supervisor = undefined;
      const journal = new Journal(
        join(f.config.root, "private/journal.sqlite"),
      );
      journal.change({
        phase,
        childPid: 2147483646,
        apply: applyRequest(f.candidate),
      });
      journal.close();
      broker = new Broker();
      supervisor = new Supervisor(f.config, broker.client());
      await supervisor.start();
      expect(supervisor.journal.read()).toMatchObject({
        phase: "UNCERTAIN",
        active: f.baseline,
      });
      await expect(supervisor.child.inspect("HEALTH", "1")).rejects.toThrow(
        "RESULT_UNKNOWN",
      );
      await expect(
        supervisor.handle(applyRequest(f.candidate, "2")),
      ).rejects.toThrow("RESULT_UNKNOWN");
    },
    15000,
  );
});
