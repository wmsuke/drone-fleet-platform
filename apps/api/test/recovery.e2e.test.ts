import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  key,
  poll,
  reconcile,
  RecoveryHarness,
  type Identity,
} from "./helpers/recovery-harness.js";

interface Buffered extends Identity {
  payload_json: string;
  attempt_count: number;
}
interface Saved extends Identity {
  source_payload: Record<string, unknown>;
  flight_status: string;
}
interface CommandHistory {
  command_id: string;
  state: string;
  started_at: string | null;
  processed_at: string | null;
}
interface Outbox {
  command_id: string;
  payload: string;
  attempts: number;
  failures: number;
  state: string;
  published_at: string | null;
}
interface Discard {
  count: number;
  first_session_id: string;
  first_sequence: number;
  last_session_id: string;
  last_sequence: number;
  reason: string;
  occurred_at: string;
}
interface Message {
  topic: string;
  payload: string;
}
const telemetry = (messages: Message[], device = "drone-001") =>
  messages
    .filter(({ topic }) => topic.endsWith("/telemetry"))
    .map(
      ({ payload }) =>
        JSON.parse(payload) as {
          deviceId: string;
          sessionId: string;
          sequence: number;
          payload: { status: string };
        },
    )
    .filter((message) => message.deviceId === device);
const acknowledgements = (messages: Message[], id: string) =>
  messages
    .filter(({ topic }) => topic.endsWith("/command-acks"))
    .map(
      ({ payload }) =>
        JSON.parse(payload) as { commandId: string; status: string },
    )
    .filter(({ commandId }) => commandId === id);

describe.skipIf(process.env.RECOVERY_E2E !== "true")(
  "通信断・再起動の復旧E2E",
  () => {
    it("突き合わせ・重複防止・期限・容量超過を実サービスで検証する", async () => {
      const harness = new RecoveryHarness();
      const scenarios = harness.report.scenarios as Record<string, unknown>;
      const saved = (device = "drone-001") =>
        harness.pg<Saved[]>(
          "SELECT session_id, sequence::integer AS sequence, source_payload, flight_status FROM telemetry WHERE device_id=$1 ORDER BY id",
          [device],
        );
      const pending = (device = "drone-001") =>
        harness.sqlite<Buffered[]>(
          "SELECT session_id, sequence, payload_json, attempt_count FROM telemetry_buffer ORDER BY id",
          device,
        );
      const history = () =>
        harness.sqlite<CommandHistory[]>(
          "SELECT command_id, state, started_at, processed_at FROM command_history ORDER BY received_at",
        );
      const outbox = (id: string) =>
        harness.pg<Outbox[]>(
          "SELECT * FROM command_outbox WHERE command_id=$1",
          [id],
        );
      const commandStatus = async (id: string) =>
        (
          await harness.pg<{ status: string }[]>(
            "SELECT status FROM commands WHERE command_id=$1",
            [id],
          )
        )[0]?.status;
      try {
        harness.phase("専用Compose環境の起動");
        await harness.start();
        await poll(
          "初回telemetry保存",
          async () => (await saved()).length >= 3,
        );

        harness.phase("broker停止中のSQLite蓄積とsimulator強制停止");
        await harness.compose(["stop", "--timeout", "3", "mqtt"]);
        await poll(
          "未確認telemetryの蓄積",
          async () => (await pending()).length >= 5,
        );
        await harness.kill("simulator");
        const backlog = await pending();
        const before = await saved();
        expect(backlog.length).toBeGreaterThanOrEqual(5);
        expect(
          await harness.sqlite("SELECT * FROM telemetry_discards"),
        ).toEqual([]);
        const oldSession = backlog[0]!.session_id;
        expect(new Set(backlog.map(({ session_id }) => session_id))).toEqual(
          new Set([oldSession]),
        );
        expect(await pending()).toEqual(backlog);

        harness.phase("broker再起動と永続バッファからの再送");
        await harness.compose(["start", "mqtt"]);
        let observer = await poll("MQTT観測接続", () => harness.observe());
        await harness.compose(["start", "simulator"]);
        const expectedBacklog = backlog.map(key);
        await poll("旧sessionの全蓄積データ保存", async () => {
          const stored = new Set((await saved()).map(key));
          return expectedBacklog.every((id) => stored.has(id));
        });
        await poll("再起動後の新規session保存", async () =>
          (await saved()).some((row) => row.session_id !== oldSession),
        );
        await poll(
          "保存確認によるSQLite削除",
          async () =>
            !(await pending()).some((row) =>
              expectedBacklog.includes(key(row)),
            ),
        );
        await harness.compose(["stop", "--timeout", "5", "simulator"]);
        const after = await saved();
        const remaining = await pending();
        const generated = [...after, ...remaining];
        const sessions = [
          ...new Set(generated.map(({ session_id }) => session_id)),
        ].map((session) => {
          const last = Math.max(
            ...generated
              .filter(({ session_id }) => session_id === session)
              .map(({ sequence }) => sequence),
          );
          const expected = Array.from(
            { length: last + 1 },
            (_, sequence) => `${session}/${sequence}`,
          );
          const result = reconcile(expected, [...new Set(generated.map(key))]);
          expect(result.missing).toEqual([]);
          return {
            sessionId: session,
            committed: last + 1,
            missing: result.missing,
          };
        });
        expect(sessions.length).toBe(2);
        const reconciliation = reconcile(expectedBacklog, after.map(key));
        expect(reconciliation).toEqual({
          missing: [],
          lost: [],
          duplicates: [],
        });
        const replayed = telemetry(observer.messages).filter((message) =>
          expectedBacklog.includes(`${message.sessionId}/${message.sequence}`),
        );
        expect(
          new Set(
            replayed.map(
              (message) => `${message.sessionId}/${message.sequence}`,
            ),
          ).size,
        ).toBe(backlog.length);
        for (const row of backlog) {
          const message = JSON.parse(row.payload_json);
          expect(
            after.find((item) => key(item) === key(row))?.source_payload,
          ).toEqual({ ...message.payload, timestamp: message.timestamp });
        }
        scenarios.telemetry = {
          bufferedAtCrash: backlog.length,
          savedBefore: before.length,
          replayedDeliveries: replayed.length,
          savedBacklogIdentities: backlog.length,
          alreadyStoredBacklogIdentities: backlog.filter((row) =>
            before.some((stored) => key(stored) === key(row)),
          ).length,
          newlyStoredBacklogIdentities: backlog.filter(
            (row) => !before.some((stored) => key(stored) === key(row)),
          ).length,
          dbRows: after.length,
          uniqueDbIdentities: new Set(after.map(key)).size,
          remainingUnconfirmed: remaining.map(key),
          sessions,
          ...reconciliation,
        };

        harness.phase("意図的なtelemetry重複配送");
        const duplicate = backlog[0]!;
        const receiptCount = () =>
          observer.messages.filter(({ topic, payload }) => {
            if (!topic.endsWith("/telemetry-receipts")) return false;
            const value = JSON.parse(payload);
            return (
              value.sessionId === duplicate.session_id &&
              value.sequence === duplicate.sequence
            );
          }).length;
        const receiptsBefore = receiptCount();
        for (let index = 0; index < 2; index++)
          await observer.client.publishAsync(
            "fleet/v1/devices/drone-001/telemetry",
            duplicate.payload_json,
            { qos: 1, retain: false },
          );
        await poll(
          "重複2回のDB保存確認receipt",
          async () => receiptCount() >= receiptsBefore + 2,
        );
        expect(
          (await saved()).filter((row) => key(row) === key(duplicate)),
        ).toHaveLength(1);
        expect(await saved()).toHaveLength(after.length);
        scenarios.telemetryDuplicate = {
          identity: key(duplicate),
          injected: 2,
          storageReceipts: receiptCount() - receiptsBefore,
          dbRowsForIdentity: 1,
        };

        harness.phase("MQTT停止中のcommand受付とAPI強制停止");
        await observer.client.endAsync(true);
        await harness.compose(["stop", "--timeout", "3", "mqtt"]);
        const response = await harness.http("/devices/drone-001/commands", {
          type: "RETURN_HOME",
        });
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as {
          commandId: string;
          status: string;
        };
        expect(accepted.status).toBe("PENDING");
        await harness.kill("api");
        const original = (await outbox(accepted.commandId))[0]!;
        expect(original.state).toBe("PENDING");
        expect(original.command_id).toBe(accepted.commandId);
        expect(await history()).toHaveLength(0);

        harness.phase("APIの未送信outbox復旧とPUBACK後の再停止");
        await harness.compose(["start", "api"]);
        await poll(
          "broker停止中のAPI再起動",
          async () => (await harness.http("/devices")).ok,
        );
        await harness.compose(["start", "mqtt"]);
        observer = await poll("broker再起動後の観測接続", () =>
          harness.observe(),
        );
        await poll(
          "機体不在でのoutbox送信確認",
          async () =>
            (await outbox(accepted.commandId))[0]?.published_at !== null,
        );
        expect(await history()).toHaveLength(0);
        await harness.kill("api");
        const sentBeforeRestart = (await outbox(accepted.commandId))[0]!;
        await harness.compose(["start", "simulator"]);
        const observedBefore = telemetry(observer.messages).length;
        await poll(
          "機体の再接続・購読",
          async () => telemetry(observer.messages).length > observedBefore,
        );
        await harness.compose(["start", "api"]);
        await poll(
          "同じcommandの再送とACKのDB反映",
          async () =>
            (await commandStatus(accepted.commandId)) === "ACKNOWLEDGED",
        );
        const processed = await poll(
          "端末の操作済み履歴",
          async () =>
            (await history()).find(
              (row) =>
                row.command_id === accepted.commandId &&
                row.state === "COMPLETED",
            ) ?? false,
        );
        expect(processed.started_at).not.toBeNull();
        expect(processed.processed_at).not.toBeNull();
        await poll("帰還操作のtelemetry反映", async () =>
          telemetry(observer.messages).some(
            (message) => message.payload.status === "RETURNING_HOME",
          ),
        );
        const finalOutbox = (await outbox(accepted.commandId))[0]!;
        expect(finalOutbox.payload).toBe(original.payload);
        expect(finalOutbox.attempts).toBeGreaterThan(
          sentBeforeRestart.attempts,
        );
        scenarios.commandOutbox = {
          commandId: accepted.commandId,
          beforeRestart: original,
          afterPublishRestart: sentBeforeRestart,
          final: finalOutbox,
          apiStatus: await commandStatus(accepted.commandId),
          simulatorHistory: processed,
        };

        harness.phase("simulator強制停止後の重複commandと期限切れcommand");
        await harness.kill("simulator");
        const earlierSessions = new Set(
          telemetry(observer.messages).map(({ sessionId }) => sessionId),
        );
        await harness.compose(["start", "simulator"]);
        const restartedSession = await poll(
          "機体再起動後の新session",
          async () =>
            telemetry(observer.messages).find(
              (message) => !earlierSessions.has(message.sessionId),
            )?.sessionId ?? false,
        );
        const acksBefore = acknowledgements(
          observer.messages,
          accepted.commandId,
        ).length;
        await observer.client.publishAsync(
          "fleet/v1/devices/drone-001/commands",
          original.payload,
          { qos: 1, retain: false },
        );
        await poll(
          "重複commandの保存済みACK再送",
          async () =>
            acknowledgements(observer.messages, accepted.commandId).length >
            acksBefore,
        );
        expect(
          (await history()).find(
            (row) => row.command_id === accepted.commandId,
          ),
        ).toEqual(processed);
        const expiredId = randomUUID();
        const expired = {
          schemaVersion: 2,
          commandId: expiredId,
          deviceId: "drone-001",
          type: "RETURN_HOME",
          timestamp: new Date(Date.now() - 2000).toISOString(),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        };
        await observer.client.publishAsync(
          "fleet/v1/devices/drone-001/commands",
          JSON.stringify(expired),
          { qos: 1, retain: false },
        );
        await poll("期限切れの否定ACK", async () =>
          acknowledgements(observer.messages, expiredId).some(
            ({ status }) => status === "REJECTED_EXPIRED",
          ),
        );
        const expiredHistory = (await history()).find(
          (row) => row.command_id === expiredId,
        )!;
        expect(expiredHistory).toMatchObject({
          state: "EXPIRED",
          started_at: null,
          processed_at: null,
        });
        await poll(
          "重複・期限切れcommand後の機体状態",
          async () =>
            telemetry(observer.messages).filter(
              ({ sessionId }) => sessionId === restartedSession,
            ).length >= 4,
        );
        expect(
          telemetry(observer.messages)
            .filter(({ sessionId }) => sessionId === restartedSession)
            .every(({ payload }) => payload.status !== "RETURNING_HOME"),
        ).toBe(true);
        scenarios.commandDeduplication = {
          commandId: accepted.commandId,
          historyUnchanged: true,
          sessionId: restartedSession,
          reexecutions: 0,
          expiredCommand: expiredHistory,
          expiredExecuted: false,
        };
        await harness.compose(["stop", "--timeout", "5", "simulator"]);

        harness.phase("STARTED commit直後の停止境界とUNCERTAIN復旧");
        const uncertainResponse = await harness.http(
          "/devices/drone-001/commands",
          { type: "RETURN_HOME" },
        );
        expect(uncertainResponse.status).toBe(202);
        const uncertainCommand = (await uncertainResponse.json()) as {
          commandId: string;
        };
        const uncertainPayload = (await outbox(uncertainCommand.commandId))[0]!
          .payload;
        // 操作開始と物理操作の間は外部から狙えないため、公開CommandStoreで停止境界を作る。
        const stage = `import { CommandStore } from './apps/simulator/dist/command-store.js';
          const store = new CommandStore('drone-001', { path: '/workspace/simulator-data/drone-001.sqlite' });
          const message = JSON.parse(${JSON.stringify(uncertainPayload)});
          if (!store.receive(message, new Date().toISOString())?.action) throw new Error('command not accepted');
          if (!store.begin(message.commandId, new Date().toISOString())?.action) throw new Error('command not started');
          process.kill(process.pid, 'SIGKILL');`;
        await expect(
          harness.compose([
            "exec",
            "-T",
            "probe",
            "node",
            "--input-type=module",
            "-e",
            stage,
          ]),
        ).rejects.toMatchObject({ code: 137 });
        expect(
          (await history()).find(
            (row) => row.command_id === uncertainCommand.commandId,
          ),
        ).toMatchObject({ state: "STARTED", processed_at: null });
        const sessionsBeforeUncertain = new Set(
          telemetry(observer.messages).map(({ sessionId }) => sessionId),
        );
        await harness.compose(["start", "simulator"]);
        const uncertainSession = await poll(
          "UNCERTAIN復旧後のtelemetry",
          async () =>
            telemetry(observer.messages).find(
              (message) => !sessionsBeforeUncertain.has(message.sessionId),
            )?.sessionId ?? false,
        );
        const uncertainHistory = await poll(
          "開始済み操作のUNCERTAIN記録",
          async () =>
            (await history()).find(
              (row) =>
                row.command_id === uncertainCommand.commandId &&
                row.state === "UNCERTAIN",
            ) ?? false,
        );
        await poll(
          "復旧後の保存済み受領ACK",
          async () =>
            (await commandStatus(uncertainCommand.commandId)) ===
            "ACKNOWLEDGED",
        );
        await poll(
          "不確定操作の自動再実行なし",
          async () =>
            telemetry(observer.messages).filter(
              ({ sessionId }) => sessionId === uncertainSession,
            ).length >= 4,
        );
        expect(uncertainHistory.started_at).not.toBeNull();
        expect(uncertainHistory.processed_at).toBeNull();
        expect(
          telemetry(observer.messages)
            .filter(({ sessionId }) => sessionId === uncertainSession)
            .every(({ payload }) => payload.status !== "RETURNING_HOME"),
        ).toBe(true);
        scenarios.commandUncertain = {
          injection:
            "公開CommandStoreでSTARTEDをcommit後、試験用execプロセスをSIGKILL",
          history: uncertainHistory,
          sessionId: uncertainSession,
          automaticReexecution: false,
          apiStatus: await commandStatus(uncertainCommand.commandId),
        };
        await harness.compose(["stop", "--timeout", "5", "simulator"]);

        harness.phase("3行バッファの上限到達と破棄記録");
        await harness.compose(["up", "-d", "--no-deps", "limited-simulator"]);
        await poll(
          "上限試験機体の初回保存",
          async () => (await saved("limited-001")).length >= 2,
        );
        await observer.client.endAsync(true);
        await harness.compose(["stop", "--timeout", "3", "mqtt"]);
        const discards = () =>
          harness.sqlite<Discard[]>(
            "SELECT * FROM telemetry_discards ORDER BY id",
            "limited-001",
          );
        await poll(
          "容量超過の破棄記録",
          async () =>
            (await discards()).reduce((total, row) => total + row.count, 0) >=
            3,
        );
        await harness.kill("limited-simulator");
        const retained = await pending("limited-001");
        const discardedBefore = await discards();
        expect(retained).toHaveLength(3);
        const limitedSession = retained[0]!.session_id;
        const committedCount =
          Math.max(...retained.map(({ sequence }) => sequence)) + 1;
        await harness.compose(["start", "mqtt"]);
        observer = await poll("上限試験の観測接続復旧", () =>
          harness.observe(),
        );
        // 3行の小さいバッファを再開する前に、ingestorの再購読とreceipt経路を確認する。
        const readiness = {
          ...JSON.parse(backlog[0]!.payload_json),
          deviceId: "recovery-probe",
          sessionId: randomUUID(),
          sequence: 0,
          timestamp: new Date().toISOString(),
        };
        await poll("ingestorの再購読とDB保存確認", async () => {
          await observer.client.publishAsync(
            "fleet/v1/devices/recovery-probe/telemetry",
            JSON.stringify(readiness),
            { qos: 1, retain: false },
          );
          return observer.messages.some(
            ({ topic, payload }) =>
              topic.endsWith("/telemetry-receipts") &&
              JSON.parse(payload).sessionId === readiness.sessionId,
          );
        });
        await harness.compose(["start", "limited-simulator"]);
        const discardedKeys = (records: Discard[]) =>
          records.flatMap((row) => {
            expect(row.first_session_id).toBe(row.last_session_id);
            expect(row.reason).toBe("ROW_LIMIT");
            expect(row.count).toBe(row.last_sequence - row.first_sequence + 1);
            return Array.from(
              { length: row.count },
              (_, offset) =>
                `${row.first_session_id}/${row.first_sequence + offset}`,
            );
          });
        await poll("上限試験の残件再送・破棄の確定", async () => {
          const keys = new Set([
            ...(await saved("limited-001")).map(key),
            ...discardedKeys(await discards()),
          ]);
          return retained.every((row) => keys.has(key(row)));
        });
        await harness.compose(["stop", "--timeout", "5", "limited-simulator"]);
        const storedLimited = (await saved("limited-001")).filter(
          ({ session_id }) => session_id === limitedSession,
        );
        const discardedAfter = await discards();
        const expectedLimited = Array.from(
          { length: committedCount },
          (_, sequence) => `${limitedSession}/${sequence}`,
        );
        const limitedReconciliation = reconcile(
          expectedLimited,
          storedLimited.map(key),
          discardedKeys(discardedAfter),
        );
        expect(limitedReconciliation.missing).toEqual([]);
        expect(limitedReconciliation.duplicates).toEqual([]);
        expect(limitedReconciliation.lost.length).toBeGreaterThan(0);
        expect(storedLimited.length + limitedReconciliation.lost.length).toBe(
          committedCount,
        );
        expect(
          storedLimited.some((row) => retained.map(key).includes(key(row))),
        ).toBe(true);
        const limitedLogs = await harness.compose([
          "logs",
          "--no-color",
          "limited-simulator",
        ]);
        expect(limitedLogs).toContain(
          "テレメトリバッファの上限に達したためデータを破棄しました",
        );
        scenarios.capacity = {
          maxRows: 3,
          sessionId: limitedSession,
          committed: committedCount,
          retainedAtCrash: retained.map(key),
          saved: storedLimited.length,
          discardedBeforeRestart: discardedBefore,
          discardedAfterRestart: discardedAfter,
          ...limitedReconciliation,
        };
        harness.report.status = "passed";
      } catch (error) {
        harness.report.status = "failed";
        harness.report.error =
          error instanceof Error ? error.stack : String(error);
        // 停止済み機体のSQLiteもprobeから読み、失敗境界を追えるようにする。
        for (const [name, read] of [
          ["telemetry", saved],
          ["buffer", pending],
          ["commandHistory", history],
        ] as const) {
          try {
            harness.report[`failure${name}`] = await read();
          } catch {
            /* 起動前の失敗では保存先がない。 */
          }
        }
        throw error;
      } finally {
        await harness.cleanup();
      }
    }, 420000);
  },
);
