// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardApp } from "../src/app.js";
import { fetchAudit, fetchAuditPage } from "../src/audit-api.js";
const id = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
const item = {
  eventId: id,
  schemaVersion: 1,
  occurredAt: "2026-10-19T00:00:00.123456Z",
  actorKind: "anonymous",
  actorId: null,
  action: "operation.accepted",
  targetKind: "operation",
  targetId: id,
  result: "SUCCEEDED",
  requestId: id,
  groupId: id,
  operationId: id,
  commandId: id,
  alertId: id,
  deviceId: "drone-001",
  metadata: { commandType: "RETURN_HOME", targetCount: 2 },
};
const json = (v: unknown) =>
  new Response(JSON.stringify(v), {
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
function mount(route = "/audit-logs", base: string | null = "http://api.test") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <DashboardApp apiBaseUrl={base} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});
it("accepts intervention audit identifiers and review lifecycle actions", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        items: [
          {
            ...item,
            action: "deployment.intervention_completed",
            targetKind: "deployment",
            metadata: {
              interventionId: id,
              reason: "INSPECTED",
              afterStatus: "KEEP_STOPPED",
            },
          },
        ],
        limit: 20,
        nextCursor: null,
      }),
    ),
  );
  const page = await fetchAuditPage("http://api.test", "");
  expect(page.items[0]!.metadata.interventionId).toBe(id);
});
it("accepts deployment audit records without breaking the existing audit list", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        items: [
          {
            ...item,
            action: "deployment.accepted",
            targetKind: "deployment",
            metadata: { targetCount: 10, afterStatus: "ACCEPTED" },
          },
        ],
        limit: 20,
        nextCursor: null,
      }),
    ),
  );
  expect((await fetchAuditPage("http://api.test", "")).items[0]?.action).toBe(
    "deployment.accepted",
  );
});
it("restores search conditions, pages by cursor and resets cursor when searching", async () => {
  const mock = vi.fn(async (url: string) => {
    const query = new URL(url).searchParams;
    return json({
      items: [
        {
          ...item,
          eventId: query.has("cursor")
            ? "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b56"
            : id,
        },
      ],
      limit: 20,
      nextCursor: query.has("cursor") ? null : "cursorToken",
    });
  });
  vi.stubGlobal("fetch", mock);
  mount("/audit-logs?actorKind=anonymous&result=SUCCEEDED");
  expect(screen.getByLabelText("actor種別")).toHaveValue("anonymous");
  await screen.findByText("このページに1件（続きあり）");
  fireEvent.click(screen.getByRole("button", { name: "次の20件" }));
  await screen.findByText("このページに1件");
  expect(mock.mock.calls.at(-1)?.[0]).toContain("cursor=cursorToken");
  expect(screen.getByRole("heading", { name: "監査ログ" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "次の20件" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("結果"), {
    target: { value: "REJECTED" },
  });
  fireEvent.click(screen.getByRole("button", { name: "検索する" }));
  await waitFor(() =>
    expect(mock.mock.calls.at(-1)?.[0]).toContain("result=REJECTED"),
  );
  expect(mock.mock.calls.at(-1)?.[0]).not.toContain("cursor=");
});
it("shows read-only detail, microseconds and links all related entities without treating storage as execution", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(item)),
  );
  mount(`/audit-logs/${id}?requestId=${id}`);
  expect(await screen.findByText("公開metadata")).toBeInTheDocument();
  expect(screen.getByText("2026-10-19T00:00:00.123456Z")).toBeInTheDocument();
  expect(
    screen.getByText(/保存成功は機体の実行完了ではない/),
  ).toBeInTheDocument();
  for (const [name, href] of [
    [`グループ ${id}`, `/groups/${id}`],
    [`操作 ${id}`, `/fleet-operations/${id}`],
    [`alert ${id}`, `/alerts/${id}`],
    [`commandの監査履歴 ${id}`, `/audit-logs?commandId=${id}`],
    ["機体・command履歴 drone-001", "/devices/drone-001#command-history-title"],
    ["同じrequestIdの記録", `/audit-logs?requestId=${id}`],
  ])
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  expect(screen.getByRole("link", { name: "検索結果へ戻る" })).toHaveAttribute(
    "href",
    `/audit-logs?requestId=${id}`,
  );
  expect(
    screen.queryByRole("button", { name: /削除|更新|編集/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("対象台数")).toBeInTheDocument();
});
it("distinguishes initial error, empty results and re-fetch failures", async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 500 }))
    .mockResolvedValueOnce(json({ items: [], limit: 20, nextCursor: null }))
    .mockResolvedValue(new Response("", { status: 500 }));
  vi.stubGlobal("fetch", mock);
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("取得できません");
  fireEvent.click(screen.getByRole("button", { name: "このページを再取得" }));
  expect(
    await screen.findByText("該当する監査ログはありません。"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "このページを再取得" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("前回の結果"),
  );
});
it("keeps search conditions when opening and returning from a result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/audit-logs?")
        ? json({ items: [item], limit: 20, nextCursor: null })
        : json(item),
    ),
  );
  mount(`/audit-logs?commandId=${id}`);
  fireEvent.click(
    await screen.findByRole("link", { name: `記録 ${id} の詳細` }),
  );
  expect(await screen.findByText("公開metadata")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "検索結果へ戻る" }));
  expect(await screen.findByLabelText("commandId")).toHaveValue(id);
});
it("rejects malformed/private metadata without displaying the raw payload and forwards cancellation", async () => {
  const mock = vi.fn().mockResolvedValue(
    json({
      ...item,
      metadata: { ...item.metadata, authorization: "test-private-value" },
    }),
  );
  vi.stubGlobal("fetch", mock);
  const signal = new AbortController().signal;
  await expect(fetchAudit("http://api.test", id, signal)).rejects.toThrow();
  expect(mock.mock.calls[0]?.[1].signal).toBe(signal);
  mock.mockResolvedValue(
    json({
      items: [
        { ...item, actorId: ["telemetry-ingestor"], actorKind: "system" },
      ],
      limit: 20,
      nextCursor: null,
    }),
  );
  await expect(fetchAuditPage("http://api.test", "", signal)).rejects.toThrow();
});
it("handles missing records and missing API settings", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
  mount(`/audit-logs/${id}`);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "記録が見つかりません",
  );
  cleanup();
  mount("/audit-logs", null);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "API接続先が設定されていません",
  );
});
