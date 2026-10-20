// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  configure,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { DashboardApp } from "../src/app.js";
import { FleetE2eHarness, eventually } from "./fleet-e2e-harness.js";
import type { OperationDetail } from "../src/fleet-operations-api.js";
import type { AlertItem } from "../src/alerts-api.js";

it.skipIf(process.env.FLEET_E2E !== "true")(
  "group操作から混在結果・alert・auditまで実HTTP/MQTT/DBで追跡する",
  async () => {
    configure({ asyncUtilTimeout: 15000 });
    const h = new FleetE2eHarness();
    let client: QueryClient | undefined;
    const mount = (path: string) => {
      cleanup();
      client?.clear();
      client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <DashboardApp apiBaseUrl={h.base} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    };
    const click = async (name: string | RegExp) => {
      const b = await screen.findByRole("button", { name });
      await waitFor(() => expect(b).toBeEnabled());
      fireEvent.click(b);
    };
    try {
      await h.start();
      if (process.env.FLEET_E2E_FAIL_AT === "after-start")
        throw new Error("cleanup確認用の意図した失敗");
      h.phase("画面からgroup作成・ONLINE/OFFLINE所属・command送信");
      mount("/groups");
      fireEvent.change(await screen.findByLabelText("グループ名"), {
        target: { value: "E2E混在隊" },
      });
      await click("作成内容を確認");
      await click("確定する");
      const groups = await eventually("group作成", async () => {
        const g = (await (await h.request("/groups")).json()) as {
          groupId: string;
          name: string;
        }[];
        return g.length === 1 ? g : false;
      });
      const groupId = groups[0]!.groupId;
      fireEvent.click(await screen.findByRole("link", { name: "E2E混在隊" }));
      for (const id of [
        "drone-001",
        "fleet-failed",
        "fleet-expired",
        "fleet-silent",
      ]) {
        await click(`${id}を追加`);
        await click("確定する");
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: `${id}の所属を解除` }),
          ).toBeEnabled(),
        );
      }
      expect(
        await screen.findByLabelText("所属台数と接続状態"),
      ).toHaveTextContent("ONLINE 3台 / OFFLINE 1台");
      await click("全機体への帰還を確認");
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("全4台へ帰還");
      fireEvent.click(within(dialog).getByRole("checkbox"));
      await click("確認したグループ全体へ送信");
      await screen.findByRole("heading", { name: "グループ操作の結果" });
      const operations = await eventually("operation作成", async () => {
        const list = (await (
          await h.request(`/fleet-operations?groupId=${groupId}`)
        ).json()) as { items: OperationDetail[] };
        return list.items.length === 1 ? list.items : false;
      });
      const operationId = operations[0]!.operationId;
      const detail = async () =>
        (await (
          await h.request(`/fleet-operations/${operationId}`)
        ).json()) as OperationDetail;
      await eventually("4機体のcommand受信", async () => h.commands.size === 4);
      const snapshot = (await detail()).targets.items.map((t) => ({
        deviceId: t.deviceId,
        commandId: t.commandId,
      }));
      expect(new Set(snapshot.map((t) => t.commandId)).size).toBe(4);
      expect((await detail()).inProgressCount).toBeGreaterThan(0);
      h.phase("実行中のmembership変更と同じkeyの再要求");
      await h.request(`/groups/${groupId}/devices/fleet-failed`, "DELETE");
      await h.request(`/groups/${groupId}/devices`, "POST", {
        deviceId: "fleet-spare",
      });
      expect(
        (await detail()).targets.items.map((t) => ({
          deviceId: t.deviceId,
          commandId: t.commandId,
        })),
      ).toEqual(snapshot);
      const [keyRow] = await h.pg<{ idempotency_key: string }[]>(
        "SELECT idempotency_key FROM fleet_operations WHERE operation_id=$1",
        [operationId],
      );
      const replay = (await (
        await h.request(
          "/fleet-operations",
          "POST",
          { groupId, type: "RETURN_HOME" },
          keyRow!.idempotency_key,
        )
      ).json()) as { operationId: string };
      expect(replay.operationId).toBe(operationId);
      expect(
        (await detail()).targets.items.map((t) => ({
          deviceId: t.deviceId,
          commandId: t.commandId,
        })),
      ).toEqual(snapshot);
      const [counts] = await h.pg<
        {
          operations: number;
          targets: number;
          commands: number;
          outboxes: number;
        }[]
      >(
        "SELECT (SELECT count(*)::int FROM fleet_operations) AS operations,(SELECT count(*)::int FROM fleet_operation_targets) AS targets,(SELECT count(*)::int FROM commands) AS commands,(SELECT count(*)::int FROM command_outbox) AS outboxes",
      );
      expect(counts).toEqual({
        operations: 1,
        targets: 4,
        commands: 4,
        outboxes: 4,
      });
      h.phase("成功・失敗・期限切れ・未応答の混在");
      const failedStart = new Date().toISOString();
      await h.ack("fleet-failed", "ACKNOWLEDGED");
      await h.ack("fleet-failed", "RUNNING", failedStart);
      await h.ack("fleet-failed", "FAILED", failedStart);
      const silentStart = new Date().toISOString();
      const expiredCommand = h.commands.get("fleet-expired")!;
      if (!("expiresAt" in expiredCommand)) throw new Error("command v2が必要");
      await eventually(
        "実時間の開始期限到達",
        async () => Date.now() > Date.parse(expiredCommand.expiresAt) + 100,
        40000,
      );
      await h.ack("fleet-expired", "REJECTED_EXPIRED");
      const mixed = await eventually("4状態の集約", async () => {
        const d = await detail();
        return d.counts.SUCCEEDED === 1 &&
          d.counts.EXECUTION_FAILED === 1 &&
          d.counts.EXPIRED === 1 &&
          d.counts.UNRESPONSIVE === 1
          ? d
          : false;
      });
      expect(mixed.status).toBe("PARTIALLY_FAILED");
      expect(
        Object.fromEntries(
          mixed.targets.items.map((t) => [t.deviceId, t.status]),
        ),
      ).toEqual({
        "drone-001": "SUCCEEDED",
        "fleet-failed": "EXECUTION_FAILED",
        "fleet-expired": "EXPIRED",
        "fleet-silent": "UNRESPONSIVE",
      });
      await act(async () => {
        mount(`/fleet-operations/${operationId}`);
      });
      await eventually("対象ごとの画面表示", async () => {
        const table = screen.queryByRole("table");
        if (!table) return false;
        const text = table.textContent ?? "";
        return ["完了", "実行失敗", "開始期限切れ", "未応答"].every((s) =>
          text.includes(s),
        );
      });
      for (const [id, label] of [
        ["drone-001", "完了"],
        ["fleet-failed", "実行失敗"],
        ["fleet-expired", "開始期限切れ"],
        ["fleet-silent", "未応答"],
      ])
        expect(
          screen.getByRole("row", { name: new RegExp(id!) }),
        ).toHaveTextContent(label!);
      const alerts = await eventually("command alert発生", async () => {
        const list = (await (
          await h.request(
            `/alerts?operationId=${operationId}&kind=COMMAND_OUTCOME`,
          )
        ).json()) as { items: AlertItem[] };
        return list.items.length === 3 ? list.items : false;
      });
      const silentAlert = alerts.find((a) => a.deviceId === "fleet-silent")!;
      expect(silentAlert.status).toBe("ACTIVE");
      fireEvent.click(screen.getByRole("link", { name: "この操作のalert" }));
      fireEvent.click(
        await screen.findByRole("link", {
          name: "fleet-silent command結果の詳細",
        }),
      );
      await click("確認済みにする");
      await screen.findByText("確認状態を保存しました。");
      const acknowledged = (await (
        await h.request(`/alerts/${silentAlert.alertId}`)
      ).json()) as AlertItem;
      expect(acknowledged.acknowledgedAt).not.toBeNull();
      expect(acknowledged.status).toBe("ACTIVE");
      h.phase("後着成功によるalert解除と確認情報保持");
      await h.ack("fleet-silent", "SUCCEEDED", silentStart);
      const resolved = await eventually("alert自動解除", async () => {
        const a = (await (
          await h.request(`/alerts/${silentAlert.alertId}`)
        ).json()) as AlertItem;
        return a.status === "RESOLVED" ? a : false;
      });
      expect(resolved.acknowledgedAt).toBe(acknowledged.acknowledgedAt);
      const recovered = await detail();
      expect(recovered.counts.SUCCEEDED).toBe(2);
      expect(recovered.status).toBe("PARTIALLY_FAILED");
      await act(async () => {
        mount(`/alerts/${silentAlert.alertId}`);
      });
      await screen.findByText("解除済み");
      fireEvent.click(
        screen.getByRole("link", { name: "このalertの監査ログ" }),
      );
      await screen.findByRole("heading", { name: "監査ログ" });
      await screen.findByText("alert.acknowledged");
      await screen.findByText("alert.resolved");
      const audit = await eventually("group・操作・alertのaudit", async () => {
        const list = (await (
          await h.request(`/audit-logs?groupId=${groupId}&limit=100`)
        ).json()) as {
          items: {
            eventId: string;
            action: string;
            metadata: Record<string, unknown>;
          }[];
        };
        return [
          "group.created",
          "membership.added",
          "membership.removed",
          "operation.accepted",
          "operation.replayed",
          "alert.acknowledged",
          "alert.resolved",
        ].every((a) => list.items.some((x) => x.action === a))
          ? list.items
          : false;
      });
      expect(
        audit.filter((x) => x.action === "operation.accepted"),
      ).toHaveLength(1);
      expect(audit.filter((x) => x.action === "command.accepted")).toHaveLength(
        4,
      );
      const ackRecord = audit.find((x) => x.action === "alert.acknowledged")!;
      fireEvent.click(
        await screen.findByRole("link", {
          name: `記録 ${ackRecord.eventId} の詳細`,
        }),
      );
      await screen.findByRole("heading", { name: "監査ログ詳細" });
      await screen.findByText("公開metadata");
      fireEvent.click(
        screen.getByRole("link", { name: `操作 ${operationId}` }),
      );
      await screen.findByRole("heading", { name: "グループ操作の結果" });
      h.report.scenarios = {
        groupId,
        operationId,
        snapshot,
        counts,
        mixed: mixed.counts,
        recovered: recovered.counts,
        alert: {
          alertId: silentAlert.alertId,
          occurredAt: resolved.occurredAt,
          acknowledgedAt: resolved.acknowledgedAt,
          resolvedAt: resolved.resolvedAt,
        },
        auditActions: audit.map((x) => x.action),
        ui: "jsdom + real HTTP (no response mocks)",
      };
      h.report.status = "passed";
      const inspect = Number(process.env.FLEET_E2E_INSPECT_MS ?? 0);
      if (!Number.isSafeInteger(inspect) || inspect < 0 || inspect > 120000)
        throw new Error("inspectは0〜120000ms");
      if (inspect) {
        h.phase(`実ブラウザ確認待ち API=${h.base}`);
        await new Promise((r) => setTimeout(r, inspect));
      }
    } catch (error) {
      h.report.status = "failed";
      h.report.failure = String(error);
      throw error;
    } finally {
      cleanup();
      client?.clear();
      sessionStorage.clear();
      await h.cleanup();
    }
  },
  540000,
);
