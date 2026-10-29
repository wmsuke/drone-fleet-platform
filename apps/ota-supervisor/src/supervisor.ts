import {
  readFile,
  mkdir,
  chmod,
  chown,
  realpath,
  lstat,
  writeFile,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonical,
  parseEnvelope,
  ReleaseError,
  type Envelope,
} from "@drone-fleet/releases";
import {
  otaRequestMessageSchema,
  otaEventContextError,
  createOtaRequestsTopic,
  createOtaEventsTopic,
  createOtaReceiptsTopic,
  createCommandsTopic,
  createTelemetryReceiptsTopic,
  parseOtaMessage,
  type OtaRequestMessage,
  type OtaApplyRequest,
} from "@drone-fleet/protocol";
import type { SimulatorMqttClient } from "@drone-fleet/simulator";
import { z } from "zod";
import semver from "semver";
import { Journal, OtaError, type EventDetails, type Model } from "./journal.js";
import { ChildHost, type Inspection } from "./child.js";
import {
  atomicWrite,
  protectTrustFile,
  fetchBytes,
  stageArtifact,
  verifyCompatible,
  verifyInstalled,
  checkCapacity,
  validateSource,
  type Source,
} from "./artifacts.js";

export interface SupervisorConfig {
  deviceId: string;
  root: string;
  data: string;
  trustPath: string;
  metadataSource: Source;
  artifactSource: Source;
  clockTrusted: boolean;
  telemetryIntervalMs: number;
}
export async function prepareDirectories(config: SupervisorConfig) {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new OtaError("INCOMPATIBLE_RELEASE");
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(config.deviceId) ||
    !config.clockTrusted ||
    config.telemetryIntervalMs < 1 ||
    config.telemetryIntervalMs > 5000
  )
    throw new OtaError("CLOCK_UNTRUSTED");
  const root = resolve(config.root);
  const data = resolve(config.data);
  if (
    root === data ||
    data.startsWith(root + "/") ||
    root.startsWith(data + "/")
  )
    throw new Error("independent data directory required");
  validateSource(config.metadataSource);
  validateSource(config.artifactSource);
  await protectTrustFile(config.trustPath, data);
  await mkdir(root, { recursive: true });
  await mkdir(data, { recursive: true });
  if ((await realpath(root)) !== root || (await realpath(data)) !== data)
    throw new Error("symlink root denied");
  await chmod(root, 0o755);
  await chmod(data, 0o700);
  await chown(data, 10001, 10001);
  await mkdir(join(root, "private"), { mode: 0o700, recursive: true });
  const stat = await lstat(join(root, "private"));
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0)
    throw new Error("private journal directory is not protected");
  await chmod(join(root, "private"), 0o700);
}
export async function fetchEnvelope(
  config: SupervisorConfig,
  identity: OtaApplyRequest["release"],
  signal: AbortSignal,
  onBytes: (n: number) => void = () => {},
) {
  const response = await fetchBytes(
    config.metadataSource,
    `/releases/${identity.releaseId}`,
    16384,
    signal,
    onBytes,
  );
  const envelope = parseEnvelope(
    canonical(JSON.parse(response.toString("utf8")).envelope),
  );
  await verifyCompatible(envelope, config.trustPath);
  const m = envelope.manifest;
  if (
    m.releaseId !== identity.releaseId ||
    m.digest !== identity.digest ||
    m.version !== identity.version ||
    m.buildId !== identity.buildId
  )
    throw new ReleaseError("DIGEST_MISMATCH");
  return envelope;
}
export async function bootstrap(
  config: SupervisorConfig,
  identity: OtaApplyRequest["release"],
) {
  await prepareDirectories(config);
  const journal = new Journal(join(config.root, "private/journal.sqlite"));
  try {
    if (journal.exists()) throw new OtaError("JOURNAL_ALREADY_EXISTS");
    try {
      await lstat(join(config.root, "private/active"));
      throw new OtaError("JOURNAL_CORRUPT");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const signal = AbortSignal.timeout(60000);
    const envelope = await fetchEnvelope(config, identity, signal);
    await checkCapacity(config.root, envelope.manifest.size);
    const bytes = await fetchBytes(
      config.artifactSource,
      `/objects/${identity.digest}.tar.gz`,
      envelope.manifest.size,
      signal,
    );
    await stageArtifact(config.root, envelope, bytes);
    await atomicWrite(join(config.root, "private/active"), identity.digest);
    await atomicWrite(join(config.root, "private/known-good"), identity.digest);
    journal.initialize(config.deviceId, envelope);
  } finally {
    journal.close();
  }
}

export class Supervisor {
  readonly journal: Journal;
  readonly child: ChildHost;
  private work?: Promise<void>;
  private abort?: AbortController;
  private stopRequest?: Extract<OtaRequestMessage, { type: "STOP_UPDATE" }>;
  private subscriptions = false;
  private lastReceipt = 0;
  private lastInventoryReceipt = 0;
  private closing = false;
  private reportTimer?: NodeJS.Timeout;
  private publishing = false;
  private reportFailures = 0;
  private inventoryAt = 0;
  private nextReportAt = 0;
  private lastTelemetrySequence = -1;
  private lastTelemetryAt = 0;
  private receiptSequence = -1;
  private receiptAt = 0;
  constructor(
    readonly config: SupervisorConfig,
    private client: SimulatorMqttClient,
  ) {
    this.journal = new Journal(join(config.root, "private/journal.sqlite"));
    this.child = new ChildHost(
      config.root,
      config.data,
      config.deviceId,
      client,
      this.journal,
      config.telemetryIntervalMs,
    );
  }
  async start() {
    const c = this.config;
    const m = this.journal.read();
    if (m.deviceId !== c.deviceId) throw new OtaError("JOURNAL_CORRUPT");
    const pointer = await readFile(join(c.root, "private/active"), "utf8");
    const good = await readFile(join(c.root, "private/known-good"), "utf8");
    if (good !== m.knownGood.manifest.digest)
      throw new OtaError("JOURNAL_CORRUPT");
    if (m.childPid !== null || m.launching) {
      this.journal.change({ phase: "UNCERTAIN", fault: "RESULT_UNKNOWN" });
      await this.attach();
      return;
    }
    if (m.phase === "UNCERTAIN" || m.fault) {
      await this.attach();
      return;
    }
    if (
      m.phase === "SWITCHING" &&
      m.candidate &&
      m.from &&
      [m.candidate.manifest.digest, m.from.manifest.digest].includes(pointer)
    ) {
      await verifyCompatible(m.candidate, c.trustPath);
      await verifyInstalled(c.root, m.candidate);
      await atomicWrite(
        join(c.root, "private/active"),
        m.candidate.manifest.digest,
      );
      this.journal.change({ active: m.candidate, phase: "BOOTING" });
    } else if (pointer !== m.active.manifest.digest)
      throw new OtaError("JOURNAL_CORRUPT");
    await verifyCompatible(this.journal.read().active, c.trustPath);
    await this.attach();
    const initialProbe = await this.child.start(this.journal.read().active);
    if (
      ["RECEIVED", "DOWNLOADING", "VERIFIED", "QUIESCING"].includes(m.phase)
    ) {
      // 旧子の終了を確認済みの場合だけ旧版から通常運転へ戻す。新適用は自動開始しない。
      this.journal.change({ phase: "FAILED", fault: null });
    } else if (
      ["BOOTING", "HEALTH_CHECKING", "SWITCHING"].includes(m.phase) &&
      m.apply?.type === "APPLY_RELEASE"
    ) {
      this.abort = new AbortController();
      this.journal.change(
        {},
        {
          type: "VERSION",
          running: {
            release: this.inspectedIdentity(initialProbe),
            bootId: initialProbe.bootId,
          },
        },
      );
      this.work = this.observe(m.apply)
        .catch((e: unknown) => this.fail(e))
        .finally(() => {
          this.work = undefined;
        });
    }
    if (m.phase === "APPLIED" && m.apply?.type === "APPLY_RELEASE")
      this.journal.change(
        {},
        {
          type: "VERSION",
          running: {
            release: this.inspectedIdentity(initialProbe),
            bootId: initialProbe.bootId,
          },
        },
      );
    this.child.gate = this.work !== undefined;
  }
  private async attach() {
    const subscribe = async () => {
      this.subscriptions = false;
      for (const topic of [
        createOtaRequestsTopic(this.config.deviceId),
        createOtaReceiptsTopic(this.config.deviceId),
      ]) {
        const grants = await this.client.subscribeAsync(topic, { qos: 1 });
        if (
          Array.isArray(grants) &&
          grants.some((g: { qos: number }) => g.qos !== 1)
        )
          throw new OtaError("DEVICE_BUSY");
      }
      this.subscriptions = true;
    };
    for (const event of ["connect", "close", "offline", "reconnect"] as const)
      this.client.on(event, () => {
        this.child.connection(event);
        if (event === "close" || event === "offline")
          this.subscriptions = false;
        if (event === "connect")
          void subscribe().catch(() => {
            this.subscriptions = false;
          });
      });
    this.client.on("message", (topic, payload, packet) => {
      if (this.closing) return;
      if (
        [
          createCommandsTopic(this.config.deviceId),
          createTelemetryReceiptsTopic(this.config.deviceId),
        ].includes(topic)
      ) {
        this.child.deliver(topic, payload, packet?.retain === true);
        return;
      }
      try {
        if (payload.length > 16384) throw new OtaError("INVALID_MESSAGE");
        const value: unknown = JSON.parse(payload.toString("utf8"));
        const metadata = packet as { qos: number; retain: boolean };
        parseOtaMessage(topic, value, metadata);
        if (topic === createOtaReceiptsTopic(this.config.deviceId)) {
          if (this.journal.confirmInventory(value)) {
            this.lastInventoryReceipt = performance.now();
            this.reportFailures = 0;
            this.nextReportAt = 0;
            return;
          }
          if (this.journal.confirm(value)) {
            this.lastReceipt = performance.now();
            this.reportFailures = 0;
            this.nextReportAt = 0;
          }
        } else if (topic === createOtaRequestsTopic(this.config.deviceId))
          void this.handle(value).catch((e: unknown) =>
            console.warn("OTA要求を拒否しました", {
              reason: e instanceof OtaError ? e.reason : "INVALID_MESSAGE",
            }),
          );
      } catch {
        console.warn("OTA入力を拒否しました");
      }
    });
    await subscribe();
    this.reportTimer = setInterval(() => void this.report(), 250);
  }
  private async report() {
    if (
      this.publishing ||
      this.closing ||
      !this.client.connected ||
      performance.now() < this.nextReportAt
    )
      return;
    this.publishing = true;
    let attempted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (
        performance.now() - this.inventoryAt >= 5000 &&
        !this.journal.pendingInventory()
      ) {
        this.inventoryAt = performance.now();
        const model = this.journal.read();
        if (
          (!model.fault || model.phase === "FAILED") &&
          model.childPid !== null
        ) {
          const probe = await this.child.inspect("HEALTH", model.highestFence);
          const budget =
            model.apply?.type === "APPLY_RELEASE"
              ? this.journal.budget(model.apply.targetId)
              : undefined;
          this.journal.inventory({
            schemaVersion: 1,
            type: "INVENTORY",
            deviceId: this.config.deviceId,
            supervisorBootId: this.journal.bootId,
            timestamp: new Date().toISOString(),
            measuredAt: probe.measuredAt,
            sampleAgeMs: Math.ceil(probe.roundTripMs),
            ...(budget
              ? {
                  recovery: {
                    knownGood: this.identity(model.knownGood),
                    attemptId: model.apply!.attemptId,
                    phase:
                      model.phase === "IDLE"
                        ? ("RECEIVED" as const)
                        : model.phase,
                    downloadedBytes: budget.bytes,
                    detectedAt: budget.detected_at,
                    budgetDeadline: budget.deadline,
                  },
                }
              : {}),
            readiness: {
              ...this.checks(probe),
              receipts:
                probe.receipts > 0 &&
                this.lastInventoryReceipt > 0 &&
                performance.now() - this.lastInventoryReceipt < 15000
                  ? "PASSED"
                  : "FAILED",
            },
            running: {
              release: this.inspectedIdentity(probe),
              bootId: probe.bootId,
            },
            capabilities: {
              application: "simulator",
              platform: process.arch === "arm64" ? "linux-arm64" : "linux-x64",
              nodeVersion: process.versions.node,
              otaProtocolVersion: "1.0.0",
              supervisorVersion: "1.0.0",
              stateSchemaVersion: "1.0.0",
              healthContractVersion: "ota-health-v1",
            },
          });
        }
      }
      const row = this.journal.pending() ?? this.journal.pendingInventory();
      if (!row) return;
      attempted = true;
      await Promise.race([
        this.client.publishAsync(
          createOtaEventsTopic(this.config.deviceId),
          row.json,
          { qos: 1, retain: false },
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("timeout")), 10000);
        }),
      ]);
    } catch {
      /* PUBACKでも削除せず、同eventを次回再送する */
    } finally {
      clearTimeout(timeout);
      if (attempted)
        this.nextReportAt =
          performance.now() +
          Math.min(8000, 1000 * 2 ** Math.min(this.reportFailures++, 3));
      else this.nextReportAt = performance.now() + 250;
      this.publishing = false;
    }
  }
  async handle(input: unknown) {
    const request = otaRequestMessageSchema.parse(input);
    if (request.deviceId !== this.config.deviceId)
      throw new OtaError("DEVICE_MISMATCH");
    if (this.journal.replay(request)) return;
    const now = Date.now();
    if (
      !this.config.clockTrusted ||
      now < Date.parse(request.createdAt) ||
      now >= Date.parse(request.expiresAt)
    )
      throw new OtaError("CLOCK_UNTRUSTED");
    const m = this.journal.read();
    if (request.type === "APPLY_RELEASE") {
      if (
        m.phase === "UNCERTAIN" ||
        (m.fault &&
          !(
            request.purpose === "ROLLBACK" &&
            m.phase === "FAILED" &&
            ["HEALTH_FAILED", "RESULT_UNKNOWN"].includes(m.fault)
          ))
      )
        throw new OtaError("RESULT_UNKNOWN");
      if (
        this.work ||
        this.journal.stopped(request.attemptId) ||
        this.journal.previousAttempt(request.attemptId)
      )
        throw new OtaError("DEVICE_BUSY");
      if (BigInt(request.fence) <= BigInt(m.highestFence))
        throw new OtaError("FENCE_CONFLICT");
      if (request.purpose === "ROLLBACK") {
        if (
          !request.recovery ||
          canonical(request.release) !==
            canonical(this.identity(m.knownGood)) ||
          request.release.digest === m.active.manifest.digest ||
          !m.knownGood.manifest.rollbackCompatible ||
          !m.active.manifest.rollbackCompatible ||
          m.knownGood.manifest.stateSchemaRange !==
            m.active.manifest.stateSchemaRange
        )
          throw new OtaError("ROLLBACK_UNAVAILABLE");
        await verifyCompatible(m.knownGood, this.config.trustPath);
        await verifyInstalled(this.config.root, m.knownGood);
        this.inspectedIdentity(
          await this.child.inspect("HEALTH", m.highestFence),
        );
      }
      if (
        request.purpose === "APPLY" &&
        !semver.gt(request.release.version, m.active.manifest.version)
      )
        throw new OtaError("INCOMPATIBLE_RELEASE");
      this.journal.transaction(() => {
        this.journal.authorize(request);
        this.journal.remember(request);
        this.journal.change(
          {
            highestFence: request.fence,
            apply: request,
            phase: "RECEIVED",
            candidate: null,
            from: null,
            downloadedBytes: 0,
            downloadAttempts: 0,
            downloadStartedAt: null,
            health: null,
            fault: null,
          },
          {
            type: "PROGRESS",
            requestType: "APPLY_RELEASE",
            state: "RECEIVED",
            commandId: request.commandId,
            downloadedBytes: 0,
            reason: null,
          },
        );
      });
      this.child.gate = true;
      this.stopRequest = undefined;
      this.abort = new AbortController();
      this.work = this.apply(request)
        .catch((e: unknown) => this.fail(e))
        .finally(() => {
          this.work = undefined;
        });
      return;
    }
    const apply = m.apply;
    if (
      !apply ||
      apply.type !== "APPLY_RELEASE" ||
      otaEventContextError(
        {
          schemaVersion: 1,
          deviceId: request.deviceId,
          deploymentId: request.deploymentId,
          stageId: request.stageId,
          targetId: request.targetId,
          attemptId: request.attemptId,
          fence: request.fence,
          release: request.release,
          applyCommandId: request.applyCommandId,
          type: "STATE",
          queryCommandId: request.commandId,
          eventId: request.commandId,
          timestamp: request.createdAt,
          sequence: 0,
          supervisorBootId: this.journal.bootId,
          state: "UNCERTAIN",
          running: null,
        },
        apply,
      )
    ) {
      if (
        request.type === "STOP_UPDATE" &&
        !this.work &&
        BigInt(request.fence) > BigInt(m.highestFence)
      ) {
        this.journal.transaction(() => {
          this.journal.remember(request);
          this.journal.stop(request.attemptId, request.fence);
          this.journal.change({ highestFence: request.fence });
        });
        return;
      }
      throw new OtaError("UNKNOWN_ATTEMPT");
    }
    this.journal.remember(request);
    if (request.type === "STOP_UPDATE") {
      this.journal.stop(request.attemptId, request.fence);
      this.stopRequest = request;
      this.journal.change(
        {},
        {
          type: "PROGRESS",
          requestType: "STOP_UPDATE",
          state: "RECEIVED",
          commandId: request.commandId,
          downloadedBytes: m.downloadedBytes,
          reason: null,
        },
      );
      this.abort?.abort();
      if (!this.work) {
        this.work = this.stopped().finally(() => {
          this.work = undefined;
        });
        await this.work;
      }
      return;
    }
    let probe: Inspection;
    try {
      probe = await this.child.inspect("HEALTH", request.fence);
    } catch {
      this.journal.change(
        {},
        {
          type: "STATE",
          queryCommandId: request.commandId,
          state: "UNCERTAIN",
          running: null,
        },
        apply,
      );
      return;
    }
    if (Date.now() >= Date.parse(request.expiresAt)) return;
    if (this.journal.read().apply?.commandId !== apply.commandId) return;
    if (request.challengeId) {
      if (
        Object.values(this.checks(probe)).includes("FAILED") &&
        this.journal.read().phase === "APPLIED"
      ) {
        this.journal.failure(apply.targetId);
        this.journal.change({ phase: "FAILED", fault: "HEALTH_FAILED" });
      }
      this.journal.change(
        {},
        this.healthEvent(probe, request.commandId, request.challengeId),
        apply,
      );
    } else
      this.journal.change(
        {},
        {
          type: "STATE",
          queryCommandId: request.commandId,
          state:
            this.journal.read().phase === "IDLE"
              ? "RECEIVED"
              : (this.journal.read().phase as "APPLIED"),
          running: {
            release: this.inspectedIdentity(probe),
            bootId: probe.bootId,
          },
        },
        apply,
      );
  }
  private identity(envelope: Envelope) {
    const { releaseId, digest, version, buildId } = envelope.manifest;
    return { releaseId, digest, version, buildId };
  }
  private inspectedIdentity(probe: Inspection) {
    return {
      releaseId: probe.releaseId,
      digest: probe.digest,
      version: probe.version,
      buildId: probe.buildId,
    };
  }
  private progress(phase: Model["phase"], patch: Partial<Model> = {}) {
    const m = this.journal.read();
    const apply = m.apply as OtaApplyRequest;
    this.journal.change(
      { ...patch, phase },
      {
        type: "PROGRESS",
        requestType: "APPLY_RELEASE",
        state: phase as "DOWNLOADING",
        commandId: apply.commandId,
        downloadedBytes: m.downloadedBytes,
        reason: null,
      },
    );
  }
  private async apply(request: OtaApplyRequest) {
    const started = Date.now();
    this.journal.change({ downloadStartedAt: started });
    const signal = AbortSignal.any([
      this.abort!.signal,
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(
            60000,
            request.recovery
              ? Date.parse(request.recovery.budgetDeadline) - Date.now()
              : 60000,
          ),
        ),
      ),
    ]);
    this.progress("DOWNLOADING");
    if (
      request.purpose !== "ROLLBACK" &&
      this.journal.budget(request.targetId)!.bytes + 16384 > 268435456
    )
      throw new OtaError("CAPACITY_EXCEEDED");
    const account = (size: number) => {
      this.journal.accountBytes(request.targetId, size);
      const next = this.journal.read().downloadedBytes + size;
      if (next > 268435456) throw new OtaError("CAPACITY_EXCEEDED");
      this.journal.change({ downloadedBytes: next });
    };
    const envelope =
      request.purpose === "ROLLBACK"
        ? this.journal.read().knownGood
        : await fetchEnvelope(this.config, request.release, signal, account);
    await verifyCompatible(envelope, this.config.trustPath);
    await checkCapacity(this.config.root, envelope.manifest.size);
    let bytes: Buffer | undefined;
    if (request.purpose === "ROLLBACK") {
      await verifyInstalled(this.config.root, envelope);
    } else
      while (this.journal.read().downloadAttempts < 3) {
        this.journal.change({
          downloadAttempts: this.journal.read().downloadAttempts + 1,
        });
        try {
          if (
            this.journal.budget(request.targetId)!.bytes +
              envelope.manifest.size >
            268435456
          )
            throw new OtaError("CAPACITY_EXCEEDED");
          bytes = await fetchBytes(
            this.config.artifactSource,
            `/objects/${request.release.digest}.tar.gz`,
            envelope.manifest.size,
            signal,
            account,
          );
          break;
        } catch (e) {
          if (
            (e instanceof ReleaseError && e.reason !== "DOWNLOAD_FAILED") ||
            e instanceof OtaError ||
            signal.aborted ||
            this.journal.read().downloadAttempts >= 3
          )
            throw e;
        }
      }
    if (request.purpose !== "ROLLBACK") {
      if (!bytes) throw new OtaError("DOWNLOAD_FAILED");
      const partial = join(this.config.root, "private/download.partial");
      await writeFile(partial, bytes, { mode: 0o600 });
      try {
        await stageArtifact(this.config.root, envelope, bytes);
      } finally {
        await unlink(partial);
      }
    }
    this.progress("VERIFIED", { candidate: envelope });
    if (this.closing) throw new OtaError("RESULT_UNKNOWN");
    if (this.stopRequest) {
      await this.stopped();
      return;
    }
    if (Date.now() >= Date.parse(request.expiresAt))
      throw new OtaError("CLOCK_UNTRUSTED");
    const receiptDeadline = Date.now() + 10000;
    while (
      !this.journal.confirmedAttempt(request.attemptId) &&
      Date.now() < receiptDeadline
    ) {
      if (this.stopRequest) {
        await this.stopped();
        return;
      }
      if (this.closing) throw new OtaError("RESULT_UNKNOWN");
      await delay(100);
    }
    if (!this.journal.confirmedAttempt(request.attemptId))
      throw new OtaError("HEALTH_FAILED");
    const readiness = await this.child.inspect("PREPARE", request.fence);
    if (
      !readiness.ready ||
      !readiness.sqlite ||
      !this.client.connected ||
      !this.subscriptions ||
      readiness.receipts < 1
    )
      throw new OtaError("DEVICE_BUSY");
    if (Date.now() >= Date.parse(request.expiresAt))
      throw new OtaError("CLOCK_UNTRUSTED");
    if (this.closing) throw new OtaError("RESULT_UNKNOWN");
    if (this.stopRequest) {
      await this.stopped();
      return;
    }
    this.progress("QUIESCING");
    await this.child.stop(request.fence);
    this.progress("SWITCHING", { from: this.journal.read().active });
    await verifyCompatible(envelope, this.config.trustPath);
    await atomicWrite(
      join(this.config.root, "private/active"),
      envelope.manifest.digest,
    );
    this.progress("BOOTING", { active: envelope });
    const probe = await this.child.start(envelope);
    this.journal.change(
      {},
      {
        type: "VERSION",
        running: { release: request.release, bootId: probe.bootId },
      },
    );
    if (this.stopRequest) {
      await this.stopped();
      return;
    }
    await this.observe(request);
  }
  private checks(probe: Inspection) {
    const now = performance.now();
    if (probe.sequence > this.lastTelemetrySequence) {
      this.lastTelemetrySequence = probe.sequence;
      this.lastTelemetryAt = now;
    }
    if (probe.receipts > this.receiptSequence) {
      this.receiptSequence = probe.receipts;
      this.receiptAt = now;
    }
    const ok = (v: boolean) => (v ? ("PASSED" as const) : ("FAILED" as const));
    return {
      eventLoop: ok(probe.roundTripMs <= 5000),
      telemetry: ok(probe.sequence > 0 && now - this.lastTelemetryAt <= 10000),
      sqlite: ok(probe.sqlite),
      commandReady: ok(probe.commandReady),
      mqtt: ok(this.client.connected),
      subscriptions: ok(
        this.subscriptions && this.child.subscriptions.size === 2,
      ),
      receipts: ok(
        probe.receipts > 0 &&
          this.lastReceipt > 0 &&
          now - this.receiptAt <= 15000,
      ),
    };
  }
  private healthEvent(
    probe: Inspection,
    queryCommandId: string,
    challengeId: string,
  ): EventDetails {
    return {
      type: "HEALTH",
      running: {
        release: this.inspectedIdentity(probe),
        bootId: probe.bootId,
      },
      queryCommandId,
      challengeId,
      measuredAt: probe.measuredAt,
      sampleMonotonicMs: Math.floor(probe.requestedMonotonicMs),
      sampleAgeMs: Math.ceil(probe.roundTripMs),
      checks: this.checks(probe),
    };
  }
  private async observe(request: OtaApplyRequest) {
    this.lastTelemetrySequence = -1;
    this.receiptSequence = -1;
    this.progress("HEALTH_CHECKING", { health: null });
    const bootDeadline = performance.now() + 30000;
    let probe = await this.child.inspect("HEALTH", request.fence);
    while (
      (!probe.receipts || !this.lastReceipt) &&
      performance.now() < bootDeadline
    ) {
      if (this.closing || this.abort?.signal.aborted)
        throw new OtaError("RESULT_UNKNOWN");
      await delay(250);
      probe = await this.child.inspect("HEALTH", request.fence);
    }
    for (let count = 1; count <= 13; count++) {
      if (this.stopRequest) {
        await this.stopped();
        return;
      }
      if (Date.now() >= Date.parse(request.resultDeadline))
        throw new OtaError("RESULT_UNKNOWN");
      probe = await this.child.inspect("HEALTH", request.fence);
      if (Object.values(this.checks(probe)).some((v) => v !== "PASSED"))
        throw new OtaError("HEALTH_FAILED");
      const now = performance.now();
      const previous = this.journal.read().health;
      if (
        previous &&
        (previous.bootId !== probe.bootId || now - previous.lastMs > 10000)
      )
        throw new OtaError("RESULT_UNKNOWN");
      this.lastTelemetrySequence = probe.sequence;
      this.journal.sample(
        {
          health: {
            count,
            startedMs: previous?.startedMs ?? now,
            lastMs: now,
            bootId: probe.bootId,
            supervisorBootId: this.journal.bootId,
          },
        },
        probe,
      );
      if (count < 13) {
        try {
          await delay(5000, undefined, { signal: this.abort?.signal });
        } catch {
          if (this.stopRequest) {
            await this.stopped();
            return;
          }
          throw new OtaError("RESULT_UNKNOWN");
        }
      }
    }
    const sample = this.journal.read().health!;
    if (sample.lastMs - sample.startedMs < 60000)
      throw new OtaError("HEALTH_FAILED");
    this.progress("APPLIED");
    this.child.gate = false;
  }
  private async stopped() {
    if (!this.stopRequest) return;
    await this.child.inspect("HEALTH", this.stopRequest.fence);
    this.journal.change(
      { phase: "STOPPED" },
      {
        type: "PROGRESS",
        requestType: "STOP_UPDATE",
        state: "STOPPED",
        commandId: this.stopRequest.commandId,
        downloadedBytes: this.journal.read().downloadedBytes,
        reason: null,
      },
    );
    await this.child.inspect("RESUME", this.stopRequest.fence);
    this.child.gate = false;
  }
  private async fail(error: unknown) {
    if (this.closing) return;
    if (this.stopRequest && !this.journal.read().fault) {
      try {
        await this.stopped();
        return;
      } catch {
        /* 不明な停止を確認済みにしない */
      }
    }
    const reason =
      error instanceof ReleaseError || error instanceof OtaError
        ? error.reason
        : "RESULT_UNKNOWN";
    const m = this.journal.read();
    if (m.apply?.type === "APPLY_RELEASE")
      this.journal.failure(m.apply.targetId);
    const uncertain =
      ["QUIESCING", "SWITCHING", "BOOTING"].includes(m.phase) ||
      reason === "RESULT_UNKNOWN";
    const phase = uncertain ? "UNCERTAIN" : "FAILED";
    try {
      this.journal.change(
        {
          phase,
          fault:
            uncertain || ["HEALTH_CHECKING", "APPLIED"].includes(m.phase)
              ? "RESULT_UNKNOWN"
              : null,
        },
        {
          type: "PROGRESS",
          requestType: "APPLY_RELEASE",
          state: phase,
          commandId: (m.apply as OtaApplyRequest).commandId,
          downloadedBytes: m.downloadedBytes,
          reason: z
            .enum([
              "INVALID_SIGNATURE",
              "UNTRUSTED_KEY",
              "DIGEST_MISMATCH",
              "SIZE_MISMATCH",
              "INCOMPATIBLE_RELEASE",
              "INVALID_ARCHIVE",
              "DOWNLOAD_FAILED",
              "DOWNLOAD_REJECTED",
              "CAPACITY_EXCEEDED",
              "CLOCK_UNTRUSTED",
              "FENCE_CONFLICT",
              "COMMAND_CONFLICT",
              "DEVICE_BUSY",
              "BOOT_FAILED",
              "HEALTH_FAILED",
              "JOURNAL_CORRUPT",
              "RESULT_UNKNOWN",
              "ROLLBACK_UNAVAILABLE",
            ])
            .safeParse(reason).success
            ? (reason as "DOWNLOAD_FAILED")
            : "DOWNLOAD_FAILED",
        },
      );
    } catch {
      this.journal.change({ phase: "UNCERTAIN", fault: "CAPACITY_EXCEEDED" });
    }
    if (!uncertain && !["HEALTH_CHECKING", "APPLIED"].includes(m.phase)) {
      try {
        await this.child.inspect("RESUME", m.highestFence);
        this.child.gate = false;
      } catch {
        this.journal.change({ phase: "UNCERTAIN", fault: "RESULT_UNKNOWN" });
      }
    }
  }
  wait() {
    return this.work ?? Promise.resolve();
  }
  async close() {
    this.closing = true;
    clearInterval(this.reportTimer);
    this.abort?.abort();
    await this.work;
    try {
      await this.child.stop(this.journal.read().highestFence);
    } catch {
      this.journal.change({ phase: "UNCERTAIN", fault: "RESULT_UNKNOWN" });
    }
    await this.client.endAsync(true);
    this.journal.close();
  }
}
