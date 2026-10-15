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
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardApp } from "../src/app.js";
import {
  accepted,
  detail,
  devices,
  group,
  groupId,
  operationId,
  json,
  list,
} from "./operation-fixtures.js";
import type {
  OperationDetail,
  TargetStatus,
} from "../src/fleet-operations-api.js";

const base = "http://api.test";
const clients: QueryClient[] = [];
const pendingKey = `fleet-operation-pending:${base}:${groupId}`;
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount(route = `/groups/${groupId}`, api: string | null = base) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <DashboardApp apiBaseUrl={api} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
function mockApi(
  options: {
    post?: (init: RequestInit) => Promise<Response>;
    operation?: () => OperationDetail;
    group?: () => ReturnType<typeof group>;
  } = {},
) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (init?.method === "POST")
      return options.post ? options.post(init) : json(accepted(), 202);
    if (u.pathname === "/devices") return json(devices());
    if (u.pathname === `/groups/${groupId}`)
      return json(options.group?.() ?? group());
    if (u.pathname === `/fleet-operations/${operationId}`) {
      const d = options.operation?.() ?? detail();
      const status = u.searchParams.get("status"),
        offset = Number(u.searchParams.get("offset") ?? 0);
      const items = (
        d.targets.total > 25
          ? Array.from({ length: d.targetCount }, (_, i) => ({
              ...d.targets.items[i % d.targets.items.length]!,
              deviceId: `drone-${i + 1}`,
              commandId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
            }))
          : d.targets.items
      ).filter((t) => !status || t.status === status);
      return json({
        ...d,
        targets: {
          items: items.slice(offset, offset + 25),
          total: items.length,
          limit: 25,
          offset,
        },
      });
    }
    if (u.pathname === "/fleet-operations")
      return json(list(u.searchParams.get("status") ? [] : [detail()]));
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function preview(type = "帰還") {
  const button = await screen.findByRole("button", {
    name: `全機体への${type}を確認`,
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.getByRole("dialog", { name: new RegExp(`全3台へ${type}`) });
}
async function confirm() {
  fireEvent.click(screen.getByRole("checkbox", { name: /全機体への操作/ }));
  const button = screen.getByRole("button", {
    name: "確認したグループ全体へ送信",
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return button;
}
it("requires an explicit group-wide confirmation, reports connection totals and restores keyboard focus on Escape", async () => {
  const fetch = mockApi();
  mount();
  const dialog = await preview("再起動");
  expect(dialog).toHaveTextContent("ONLINE 1台 / OFFLINE 2台 / 状態未取得 0台");
  expect(dialog).toHaveTextContent("最終対象と台数はAPI受付時の構成で確定");
  expect(dialog).toHaveTextContent("受付後はキャンセルできません");
  expect(dialog).toHaveTextContent("再起動は通信を切断");
  expect(
    screen.getByRole("button", { name: "送信をキャンセル" }),
  ).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "確認したグループ全体へ送信" }),
  ).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("button", { name: "送信をキャンセル" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "グループ全体へのコマンド" }),
  ).toHaveFocus();
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(0);
});
it("persists the key before posting, blocks double clicks and navigates to durable result URL", async () => {
  let finish!: (r: Response) => void;
  const fetch = mockApi({
    post: async () => {
      expect(sessionStorage.getItem(pendingKey)).not.toBeNull();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  mount();
  await preview();
  const button = await confirm();
  fireEvent.click(button);
  expect(
    await screen.findByRole("button", { name: "受付を確認中…" }),
  ).toBeDisabled();
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  const saved = JSON.parse(sessionStorage.getItem(pendingKey)!);
  expect(saved).toMatchObject({
    groupId,
    type: "RETURN_HOME",
    key: expect.any(String),
  });
  await act(async () => finish(json(accepted(), 202)));
  expect(
    await screen.findByRole("heading", { name: "グループ操作の結果" }),
  ).toHaveFocus();
  expect(await screen.findByText(`操作ID: ${operationId}`)).toBeInTheDocument();
  expect(sessionStorage.getItem(pendingKey)).toBeNull();
});
it("reuses the same key/body after network failure and after a reload without automatic posting", async () => {
  let failed = true;
  const fetch = mockApi({
    post: async () => {
      if (failed) throw new Error("lost response");
      return json(accepted(), 202);
    },
  });
  const first = mount();
  await preview();
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "受付済みの可能性",
  );
  const original = fetch.mock.calls.find(
    ([, init]) => init?.method === "POST",
  )![1]!;
  first.unmount();
  clients.forEach((c) => c.clear());
  mount();
  await screen.findByRole("button", { name: "同じ要求で受付を確認" });
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "同じ要求で受付を確認" }));
  await screen.findByRole("heading", { name: "グループ操作の結果" });
  const requests = fetch.mock.calls.filter(
    ([, init]) => init?.method === "POST",
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]![1]!.headers).toEqual(original.headers);
  expect(requests[1]![1]!.body).toEqual(original.body);
});
it("does not send when session storage fails or contains a corrupt pending request", async () => {
  const fetch = mockApi();
  sessionStorage.setItem(pendingKey, "broken JSON");
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "安全に保存・復元できません",
  );
  expect(
    screen.getByRole("button", { name: "全機体への帰還を確認" }),
  ).toBeDisabled();
  cleanup();
  sessionStorage.clear();
  mount();
  await preview();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "安全に保存・復元できません",
  );
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(0);
});
it("detects membership changes during confirmation and requires another preview", async () => {
  mockApi();
  const { client } = mount();
  await preview();
  act(() =>
    client.setQueryData(["groups", base, groupId], {
      ...group(),
      revision: 2,
      deviceIds: ["drone-001"],
      deviceCount: 1,
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "構成が変わりました",
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /全機体への操作/ }));
  expect(
    screen.getByRole("button", { name: "確認したグループ全体へ送信" }),
  ).toBeDisabled();
});
it("disables new group operations for an empty group or unavailable connection data", async () => {
  mockApi({ group: () => ({ ...group(), deviceCount: 0, deviceIds: [] }) });
  mount();
  await screen.findByText("所属機体はありません。");
  expect(
    screen.getByRole("button", { name: "全機体への帰還を確認" }),
  ).toBeDisabled();
});
it("shows partial results and all count categories without treating receipt as success", async () => {
  mockApi({
    operation: () =>
      detail([
        "SUCCEEDED",
        "ACKNOWLEDGED",
        "UNRESPONSIVE",
        "EXECUTION_FAILED",
        "DELIVERY_FAILED",
        "EXPIRED",
        "UNCERTAIN",
      ]),
  });
  mount(`/fleet-operations/${operationId}`);
  await screen.findByRole("table");
  expect(await screen.findByText(/全体: 進行中/)).toHaveTextContent(
    "完了1台 / 不成功5台 / 進行中1台",
  );
  const table = screen.getByRole("table", {
    name: "対象ごとのcommand状態と更新時刻",
  });
  expect(within(table).getByText("受領済み・結果待ち")).toBeInTheDocument();
  expect(within(table).getByText("未応答")).toBeInTheDocument();
  expect(
    within(table).getByRole("link", { name: "drone-001" }),
  ).toHaveAttribute("href", "/devices/drone-001");
  expect(screen.getByLabelText("全対象の結果内訳")).toBeInTheDocument();
});
it.each([
  "UNRESPONSIVE",
  "EXECUTION_FAILED",
  "DELIVERY_FAILED",
  "EXPIRED",
] as const)(
  "filters %s while preserving whole-operation totals",
  async (status) => {
    const fetch = mockApi({
      operation: () =>
        detail([
          "SUCCEEDED",
          "UNRESPONSIVE",
          "EXECUTION_FAILED",
          "DELIVERY_FAILED",
          "EXPIRED",
        ]),
    });
    mount(`/fleet-operations/${operationId}`);
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("対象の状態で絞り込む"), {
      target: { value: status },
    });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(screen.getByText(/全体: 一部不成功/)).toHaveTextContent(
      "対象5台 / 完了1台 / 不成功4台",
    );
    expect(
      fetch.mock.calls.some(([url]) => url.includes(`status=${status}`)),
    ).toBe(true);
  },
);
it("paginates 100 targets on the server and restores filter/page from URL", async () => {
  const fetch = mockApi({
    operation: () => detail(Array<TargetStatus>(100).fill("SUCCEEDED")),
  });
  mount(`/fleet-operations/${operationId}?offset=25&status=SUCCEEDED`);
  await screen.findByRole("table");
  expect(screen.getAllByRole("row")).toHaveLength(26);
  expect(screen.getByText("100件中 26〜50件")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "次のページ" }));
  await screen.findByText("100件中 51〜75件");
  expect(
    fetch.mock.calls.some(([url]) =>
      url.includes("offset=50&status=SUCCEEDED"),
    ),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("対象の状態で絞り込む"), {
    target: { value: "EXPIRED" },
  });
  expect(
    await screen.findByText("この条件・ページに一致する対象はありません。"),
  ).toBeInTheDocument();
  expect(screen.getByText("0件中 0〜0件")).toBeInTheDocument();
});
it("shows an empty range without invented row numbers when the URL page is out of bounds", async () => {
  mockApi();
  mount(`/fleet-operations/${operationId}?offset=25`);
  expect(await screen.findByText("3件中 0〜0件")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "前のページ" }));
  expect(await screen.findByText("3件中 1〜3件")).toBeInTheDocument();
});
it("reopens the result URL with GET only, and keeps polling terminal outcomes for late evidence", async () => {
  vi.useFakeTimers();
  let value = detail();
  const fetch = mockApi({ operation: () => value });
  const mounted = mount(`/fleet-operations/${operationId}`);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByText(/全体: 一部不成功/)).toBeInTheDocument();
  value = detail(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
  await act(async () => vi.advanceTimersByTimeAsync(5001));
  expect(screen.getByText(/全体: 全件完了/)).toBeInTheDocument();
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(0);
  const count = fetch.mock.calls.length;
  mounted.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetch).toHaveBeenCalledTimes(count);
});
it("retains previous data on refresh errors and recovers through manual refresh", async () => {
  const fetch = mockApi();
  mount(`/fleet-operations/${operationId}`);
  await screen.findByRole("table");
  fetch.mockResolvedValue(json({}, 503));
  fireEvent.click(screen.getByRole("button", { name: "結果を再取得" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "前回取得した結果",
  );
  expect(screen.getByRole("table")).toBeInTheDocument();
  fetch.mockResolvedValue(json(detail(["SUCCEEDED"])));
  fireEvent.click(screen.getByRole("button", { name: "結果を再取得" }));
  expect(await screen.findByText(/全体: 全件完了/)).toBeInTheDocument();
});
it("shows loading, missing operation, invalid URL and missing configuration without posting", async () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetch);
  const first = mount(`/fleet-operations/${operationId}`);
  expect(screen.getByRole("status")).toHaveTextContent("読み込んでいます");
  first.unmount();
  fetch.mockResolvedValue(json({}, 404));
  mount(`/fleet-operations/${operationId}`);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "操作が見つかりません",
  );
  cleanup();
  mount(`/fleet-operations/bad-id`);
  expect(screen.getByRole("alert")).toHaveTextContent("操作IDの形式が不正");
  cleanup();
  mount(`/fleet-operations/${operationId}?offset=-1`);
  expect(screen.getByRole("alert")).toHaveTextContent("絞り込み条件が不正");
  cleanup();
  mount(`/fleet-operations/${operationId}`, null);
  expect(screen.getByRole("alert")).toHaveTextContent("VITE_API_BASE_URL");
});
it("provides navigable operation history and group-scoped history links", async () => {
  mockApi();
  mount(`/fleet-operations?groupId=${groupId}`);
  fireEvent.click(
    await screen.findByRole("link", { name: "受付時の訓練隊 / 帰還" }),
  );
  expect(
    await screen.findByRole("heading", { name: "グループ操作の結果" }),
  ).toHaveFocus();
  expect(await screen.findByText(`操作ID: ${operationId}`)).toBeInTheDocument();
});
