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
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardApp } from "../src/app.js";
import { fetchAlerts, fetchAlert } from "../src/alerts-api.js";
const id = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
const item = {
  alertId: id,
  deviceId: "drone-001",
  commandId: null,
  kind: "OFFLINE",
  status: "ACTIVE",
  severity: "warning",
  reason: "OFFLINE",
  occurredAt: "2026-10-19T00:00:00Z",
  lastObservedAt: "2026-10-19T00:01:00Z",
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedActorKind: null,
  acknowledgedActorId: null,
  operationId: null,
  relatedGroups: [],
};
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const json = (v: unknown) =>
  new Response(JSON.stringify(v), {
    headers: { "Content-Type": "application/json" },
  });
function mount(route = "/alerts") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <DashboardApp apiBaseUrl="http://api.test" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
it("restores URL filters and follows historical group/operation links", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/alerts?")
        ? json({ items: [item], total: 1, limit: 20, offset: 0 })
        : json({
            ...item,
            operationId: id,
            relatedGroups: [{ groupId: id, name: "開始時の隊" }],
          }),
    ),
  );
  mount(`/alerts?status=RESOLVED&groupId=${id}&acknowledged=false`);
  expect(screen.getByLabelText("状態")).toHaveValue("RESOLVED");
  expect(screen.getByLabelText("グループID")).toHaveValue(id);
  fireEvent.click(
    await screen.findByRole("link", { name: "drone-001 通信断の詳細" }),
  );
  expect(
    await screen.findByRole("link", { name: "グループ 開始時の隊" }),
  ).toHaveAttribute("href", `/groups/${id}`);
  expect(
    screen.getByRole("link", { name: `グループ操作 ${id}` }),
  ).toHaveAttribute("href", `/fleet-operations/${id}`);
});
it("does not submit invalid or reversed periods", async () => {
  const mock = vi.fn(async () =>
    json({ items: [], total: 0, limit: 20, offset: 0 }),
  );
  vi.stubGlobal("fetch", mock);
  mount();
  await screen.findByText("該当するalertはありません。");
  fireEvent.change(screen.getByLabelText("発生開始（UTC）"), {
    target: { value: "invalid" },
  });
  fireEvent.click(screen.getByRole("button", { name: "絞り込む" }));
  expect(screen.getByRole("alert")).toHaveTextContent("期間が不正");
  expect(mock).toHaveBeenCalledTimes(1);
});
it("renders many alerts, pages and filters without duplicate rows", async () => {
  const mock = vi.fn(async (url: string) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    return json({
      items: Array.from({ length: offset ? 1 : 20 }, (_, i) => ({
        ...item,
        alertId: `${id.slice(0, -2)}${String(offset + i).padStart(2, "0")}`,
      })),
      total: 21,
      limit: 20,
      offset,
    });
  });
  vi.stubGlobal("fetch", mock);
  mount();
  expect(await screen.findByText("全21件 / 1〜20件")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: /の詳細/ })).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "次へ" }));
  expect(await screen.findByText("全21件 / 21〜21件")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "次へ" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("状態"), {
    target: { value: "RESOLVED" },
  });
  fireEvent.click(screen.getByRole("button", { name: "絞り込む" }));
  await waitFor(() =>
    expect(mock.mock.calls.at(-1)?.[0]).toContain("status=RESOLVED"),
  );
  expect(mock.mock.calls.at(-1)?.[0]).not.toContain("offset=20");
  expect(screen.getByRole("heading", { name: "alert一覧" })).toHaveFocus();
});
it("shows empty results and errors, permits retry", async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 500 }))
    .mockResolvedValue(json({ items: [], total: 0, limit: 20, offset: 0 }));
  vi.stubGlobal("fetch", mock);
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("取得できません");
  fireEvent.click(screen.getByRole("button", { name: "再試行" }));
  expect(
    await screen.findByText("該当するalertはありません。"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "次へ" })).toBeDisabled();
});
it("acknowledges independently from active/resolved status with anonymous identity notice", async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) =>
    json(
      init?.method === "POST"
        ? {
            ...item,
            acknowledgedAt: "2026-10-19T01:00:00Z",
            acknowledgedActorKind: "anonymous",
          }
        : item,
    ),
  );
  vi.stubGlobal("fetch", mock);
  mount(`/alerts/${id}`);
  fireEvent.click(
    await screen.findByRole("button", { name: "確認済みにする" }),
  );
  expect(
    await screen.findByText("確認状態を保存しました。"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "確認済み" })).toBeDisabled();
  expect(screen.getByText("発生中")).toBeInTheDocument();
  expect(screen.getByText("匿名（本人性未確認）")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "機体 drone-001" })).toHaveAttribute(
    "href",
    "/devices/drone-001",
  );
});
it("retains the acknowledgement action on save failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response("", { status: 500 })
        : json({
            ...item,
            status: "RESOLVED",
            resolvedAt: "2026-10-19T01:00:00Z",
          }),
    ),
  );
  mount(`/alerts/${id}`);
  fireEvent.click(
    await screen.findByRole("button", { name: "確認済みにする" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("保存できません");
  expect(screen.getByRole("button", { name: "確認済みにする" })).toBeEnabled();
  expect(screen.getByText("解除済み")).toBeInTheDocument();
});
it("refreshes periodically and retains previous results on refresh failure", async () => {
  vi.useFakeTimers();
  const mock = vi
    .fn()
    .mockResolvedValueOnce(
      json({ items: [item], total: 1, limit: 20, offset: 0 }),
    )
    .mockResolvedValue(new Response("", { status: 500 }));
  vi.stubGlobal("fetch", mock);
  mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(screen.getByText("全1件 / 1〜1件")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5100);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("前回の取得結果");
  expect(screen.getByText("全1件 / 1〜1件")).toBeInTheDocument();
});
it("rejects malformed API data and forwards filters/cancellation", async () => {
  const mock = vi.fn().mockResolvedValue(
    json({
      items: [{ ...item, severity: "unknown" }],
      total: 1,
      limit: 20,
      offset: 0,
    }),
  );
  vi.stubGlobal("fetch", mock);
  const controller = new AbortController();
  await expect(
    fetchAlerts("http://api.test", "deviceId=drone-001", controller.signal),
  ).rejects.toThrow();
  expect(mock.mock.calls[0]?.[1].signal).toBe(controller.signal);
  mock.mockResolvedValue(json({}));
  await expect(fetchAlert("http://api.test", id)).rejects.toThrow();
});
