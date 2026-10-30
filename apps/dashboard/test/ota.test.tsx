// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardApp } from "../src/app.js";
import { otaFixture, intervention } from "./ota-fixtures.js";

const base = "http://api.test";
let f: ReturnType<typeof otaFixture>;
const clients: QueryClient[] = [];
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function serve(
  post: (path: string, options: RequestInit) => Promise<Response> = async () =>
    json({ error: "REJECTED" }, 409),
  records: ReturnType<typeof intervention>[] = [],
) {
  const mock = vi.fn(
    async (value: string | URL | Request, options: RequestInit = {}) => {
      const url = new URL(String(value));
      if (options.method === "POST") return post(url.pathname, options);
      if (url.pathname === "/releases")
        return json({ items: [f.release], limit: 100 });
      if (url.pathname === "/groups") return json([]);
      if (url.pathname.endsWith("/interventions"))
        return json({ items: records, limit: 20, nextCursor: null });
      if (url.pathname === "/deployments")
        return json({
          items: [{ ...f.data, counts: {} }],
          limit: 20,
          nextBefore: null,
          nextBeforeId: null,
        });
      return json(f.data);
    },
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
function mount(route = `/deployments/${f.data.deploymentId}`) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <DashboardApp apiBaseUrl={base} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function readyReason() {
  const input = await screen.findByLabelText("操作理由コード");
  fireEvent.change(input, { target: { value: "LOCAL_DEMO" } });
}
function confirm() {
  fireEvent.click(
    screen.getByLabelText("対象・段階・理由と操作の影響を確認した"),
  );
  fireEvent.click(screen.getByRole("button", { name: "確認した操作を送信" }));
}
function expandTarget(id = "drone-001") {
  const summary = screen.getByText(`${id}の根拠・履歴・復旧`);
  const details = summary.closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
beforeEach(() => {
  sessionStorage.clear();
  f = otaFixture();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each([408, 503])(
  "keeps an HTTP %s operation ambiguous instead of generating a new request",
  async (status) => {
    serve(async () => json({ error: "TEMPORARY_FAILURE" }, status));
    mount();
    await readyReason();
    fireEvent.click(
      screen.getAllByRole("button", { name: "段階承認を確認" })[0]!,
    );
    confirm();
    await screen.findByRole("button", { name: "同じ要求で受付を確認" });
    await screen.findByRole("alert");
    expect(sessionStorage.getItem(`ota-pending:${base}`)).not.toBeNull();
  },
);
it("includes the full request latency in freshness and does not enable operations on a slow response", async () => {
  let elapsed = 100;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  let resolve!: (r: Response) => void;
  const waiting = new Promise<Response>((r) => {
    resolve = r;
  });
  const normal = serve().getMockImplementation()!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) =>
      String(url).includes(`/deployments/${f.data.deploymentId}?`)
        ? waiting
        : normal(url, options),
    ),
  );
  mount();
  await screen.findByText("配信情報を読み込み中…");
  elapsed += 11000;
  resolve(json(f.data));
  expect(await screen.findByLabelText("操作理由コード")).toBeDisabled();
  expect(
    screen.getAllByRole("button", { name: "段階承認を確認" })[0],
  ).toBeDisabled();
});
it("does not send when the confirmed request cannot be saved", async () => {
  const mock = serve();
  mount();
  await readyReason();
  fireEvent.click(
    screen.getAllByRole("button", { name: "段階承認を確認" })[0]!,
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  confirm();
  await screen.findByText(/要求の保存・復元に失敗/);
  expect(mock.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(
    0,
  );
});

it("previews release, fixed targets, stages and stop conditions before creating a deployment", async () => {
  const mock = serve(async (_path, options) => {
    expect(JSON.parse(String(options.body))).toMatchObject({
      releaseId: f.release.releaseId,
      stages: [{ deviceIds: ["drone-001"] }, { deviceIds: ["drone-002"] }],
    });
    return json({ deploymentId: f.data.deploymentId, status: "ACCEPTED" }, 202);
  });
  mount("/deployments");
  await screen.findByRole("option", { name: new RegExp(f.release.version) });
  fireEvent.change(screen.getByLabelText("配信物"), {
    target: { value: f.release.releaseId },
  });
  fireEvent.change(
    screen.getByLabelText("機体ID（空白・改行・カンマ区切り）"),
    { target: { value: "drone-002, drone-001" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "対象と段階を確認" }));
  expect(
    screen.getByRole("region", { name: "OTA操作の最終確認" }),
  ).toHaveTextContent(f.release.digest);
  expect(
    screen.getByRole("button", { name: "確認した操作を送信" }),
  ).toBeDisabled();
  expect(mock.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(
    0,
  );
  confirm();
  await screen.findByRole("heading", { name: "OTA配信の詳細" });
  expect(mock.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(
    1,
  );
});
it("requires reason, protects confirmation from double clicks, and tracks approval acceptance separately", async () => {
  let release!: (r: Response) => void;
  const waiting = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const mock = serve(async () => waiting);
  mount();
  const approve = await screen.findAllByRole("button", {
    name: "段階承認を確認",
  });
  expect(approve[0]).toBeDisabled();
  await readyReason();
  fireEvent.click(approve[0]!);
  expect(
    screen.getByRole("button", { name: "確認をキャンセル" }),
  ).toHaveFocus();
  fireEvent.click(
    screen.getByLabelText("対象・段階・理由と操作の影響を確認した"),
  );
  const send = screen.getByRole("button", { name: "確認した操作を送信" });
  fireEvent.click(send);
  fireEvent.click(send);
  await waitFor(() =>
    expect(
      mock.mock.calls.filter(([, o]) => o?.method === "POST"),
    ).toHaveLength(1),
  );
  release(
    json(
      {
        deploymentId: f.data.deploymentId,
        actionId: crypto.randomUUID(),
        interventionId: crypto.randomUUID(),
        status: "RUNNING",
      },
      202,
    ),
  );
  await screen.findByText(/段階承認を受け付けました/);
  expect(screen.getByText(/段階承認を受け付けました/)).toHaveTextContent(
    "成功は別途確認",
  );
});
it("cancels with Escape, restores keyboard focus and never posts a cancelled preview", async () => {
  const mock = serve();
  mount();
  await readyReason();
  const button = screen.getAllByRole("button", { name: "段階承認を確認" })[0]!;
  button.focus();
  fireEvent.click(button);
  fireEvent.keyDown(screen.getByRole("button", { name: "確認をキャンセル" }), {
    key: "Escape",
  });
  await waitFor(() => expect(button).toHaveFocus());
  expect(
    screen.queryByRole("region", { name: "OTA操作の最終確認" }),
  ).not.toBeInTheDocument();
  expect(mock.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(
    0,
  );
});
it("promotes a later stage only after all prior targets have new fresh success evidence", async () => {
  const mock = serve(async (path) =>
    json(
      {
        deploymentId: f.data.deploymentId,
        interventionId: crypto.randomUUID(),
        actionId: crypto.randomUUID(),
        status: "RUNNING",
        path,
      },
      202,
    ),
  );
  mount();
  await readyReason();
  expect(
    screen.getAllByRole("button", { name: "段階承認を確認" })[1],
  ).toBeDisabled();
  const t = f.data.targets[0]!,
    a = t.attempts[0]!;
  f.data.status = "RUNNING";
  f.data.stages[0]!.status = "PASSED";
  f.data.stages[0]!.counts = { SUCCEEDED: 1 };
  f.data.stages[1]!.status = "AWAITING_APPROVAL";
  t.status = "SUCCEEDED";
  a.deliveryStatus = "ACKNOWLEDGED";
  a.applicationStatus = "APPLIED";
  a.evaluationStatus = "SUCCEEDED";
  a.freshHealth = true;
  t.current = { ...f.next, bootId: crypto.randomUUID(), observedAt: f.at() };
  a.events = [
    {
      eventId: crypto.randomUUID(),
      sequence: "15",
      acceptance: "ACCEPTED",
      reason: null,
      storedAt: f.at(),
      receivedAt: f.at(),
      occurredAt: f.at(),
      payload: { type: "HEALTH" },
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "最新状態を取得" }));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "段階承認を確認" })[1],
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "段階承認を確認" })[1]!,
  );
  confirm();
  await waitFor(() =>
    expect(
      mock.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1),
  );
  expect(
    String(
      mock.mock.calls.find(([, options]) => options?.method === "POST")![0],
    ),
  ).toContain(`/stages/${f.data.stages[1]!.stageId}/approve`);
});
it("displays rollback success as old-version recovery without claiming original update completion", async () => {
  f.failed("ROLLBACK");
  f.data.status = "WAITING_FOR_HUMAN";
  f.data.targets[0]!.status = "RECOVERED";
  const a = f.data.targets[0]!.attempts[0]!;
  f.data.recoveries.push({
    recoveryId: crypto.randomUUID(),
    targetId: f.data.targets[0]!.targetId,
    previousAttemptId: a.attemptId,
    rootAttemptId: a.attemptId,
    attemptId: crypto.randomUUID(),
    kind: "ROLLBACK",
    status: "SUCCEEDED",
    reason: "APPROVED_ROLLBACK",
    failureReason: null,
    requiredAction: null,
    detectedAt: f.at(-10000),
    approvedAt: f.at(-9000),
    notBefore: f.at(-9000),
    startedAt: f.at(-8000),
    finishedAt: f.at(),
    budgetDeadline: f.at(890000),
    bytesAtApproval: 256,
    downloadedBytes: 256,
    cost: null,
    evidence: [],
  });
  serve();
  mount();
  await screen.findByText(
    "ROLLBACK — 旧版への回復成功（元更新の成功ではない）",
  );
  expect(
    screen.queryByText("全対象の更新成功 (COMPLETED)"),
  ).not.toBeInTheDocument();
});
it("restores an ambiguous operation after reload, does not automatically send, and reuses the exact key and body", async () => {
  const mock = serve(async () => {
    throw new TypeError("offline");
  });
  const first = mount();
  await readyReason();
  fireEvent.click(
    screen.getAllByRole("button", { name: "段階承認を確認" })[0]!,
  );
  confirm();
  await screen.findByText(/通信または応答形式のエラー/);
  const initialPost = mock.mock.calls.find(([, o]) => o?.method === "POST")!;
  first.unmount();
  mount();
  await screen.findByRole("button", { name: "同じ要求で受付を確認" });
  expect(mock.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(
    1,
  );
  fireEvent.click(screen.getByRole("button", { name: "同じ要求で受付を確認" }));
  await waitFor(() =>
    expect(
      mock.mock.calls.filter(([, o]) => o?.method === "POST"),
    ).toHaveLength(2),
  );
  const secondPost = mock.mock.calls.filter(
    ([, o]) => o?.method === "POST",
  )[1]!;
  expect(secondPost[1]!.headers).toEqual(initialPost[1]!.headers);
  expect(secondPost[1]!.body).toEqual(initialPost[1]!.body);
});
it("fails closed when session storage is corrupt or cannot persist the operation", async () => {
  sessionStorage.setItem(`ota-pending:${base}`, "not-json");
  const mock = serve();
  mount();
  await screen.findByText(/要求の保存・復元に失敗/);
  await screen.findByLabelText("操作理由コード");
  expect(
    screen.getAllByRole("button", { name: "段階承認を確認" })[0],
  ).toBeDisabled();
  expect(mock.mock.calls.filter(([, o]) => o?.method === "POST")).toHaveLength(
    0,
  );
});
it("keeps all fixed denominators while paging 100 targets and preserves the page on reload", async () => {
  f = otaFixture(100);
  serve();
  const view = mount();
  await screen.findByRole("table");
  expect(screen.getByRole("table")).toHaveTextContent("全100台");
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
    21,
  );
  fireEvent.click(screen.getByRole("button", { name: "次の対象ページ" }));
  expect(screen.getByRole("link", { name: "drone-021" })).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "drone-001" }),
  ).not.toBeInTheDocument();
  view.unmount();
  mount(`/deployments/${f.data.deploymentId}?targetPage=2`);
  await screen.findByRole("link", { name: "drone-021" });
});
it("distinguishes unknown execution and stopping from stopped and disables unsafe recovery", async () => {
  f.failed();
  f.data.status = "WAITING_FOR_HUMAN";
  f.data.targets[0]!.attempts[0]!.evaluationStatus = "UNCERTAIN";
  f.data.targets[0]!.attempts[0]!.stop = {
    commandId: crypto.randomUUID(),
    confirmedEventId: null,
    attempts: 5,
    resultDeadline: f.at(60000),
  };
  serve();
  mount();
  await readyReason();
  expandTarget();
  expect(
    await screen.findByRole("button", { name: "再試行承認を確認" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "rollback承認を確認" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "配信再開を確認" })).toBeDisabled();
  expect(screen.getByText(/停止要求済み・未確認/)).toBeInTheDocument();
  expect(screen.getAllByText(/結果不明/).length).toBeGreaterThan(0);
});
it("offers only an eligible retry and displays a persisted rejection as rejection, not recovery success", async () => {
  f.failed();
  const mock = serve(async () =>
    json(
      {
        deploymentId: f.data.deploymentId,
        recoveryId: crypto.randomUUID(),
        interventionId: crypto.randomUUID(),
        targetId: f.data.targets[0]!.targetId,
        kind: "RETRY",
        status: "UNAVAILABLE",
        failureReason: "RELEASE_UNAVAILABLE",
      },
      409,
    ),
  );
  mount();
  await readyReason();
  expandTarget();
  fireEvent.click(
    await screen.findByRole("button", { name: "再試行承認を確認" }),
  );
  confirm();
  expect(await screen.findByText(/復旧要求は拒否されました/)).toHaveTextContent(
    "回復成功ではありません",
  );
  const post = mock.mock.calls.find(([, o]) => o?.method === "POST")!;
  expect(JSON.parse(String(post[1]!.body))).toEqual({
    kind: "RETRY",
    reason: "LOCAL_DEMO",
  });
  expect(sessionStorage.getItem(`ota-pending:${base}`)).toBeNull();
});
it("can reload up to 100 evidence events before allowing a rollback with a complete history", async () => {
  f.failed("ROLLBACK");
  f.data.targets[0]!.attempts[0]!.eventsTruncated = true;
  const mock = serve();
  mount();
  await readyReason();
  expandTarget();
  expect(
    await screen.findByRole("button", { name: "rollback承認を確認" }),
  ).toBeDisabled();
  f.data.targets[0]!.attempts[0]!.eventsTruncated = false;
  fireEvent.click(
    screen.getByRole("button", { name: "根拠を100件まで読み直す" }),
  );
  await readyReason();
  expandTarget();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "rollback承認を確認" }),
    ).toBeEnabled(),
  );
  expect(
    mock.mock.calls.some(([url]) => String(url).includes("eventLimit=100")),
  ).toBe(true);
});
it("keeps intervention classification, missing time/cost and audit links and records a review disposition only", async () => {
  f.failed();
  f.data.status = "WAITING_FOR_HUMAN";
  const i = intervention(f.data, true),
    records = [i, intervention(f.data)];
  const mock = serve(
    async () =>
      json(
        {
          deploymentId: f.data.deploymentId,
          interventionId: i.interventionId,
          finishedAt: f.at(),
          outcome: "KEEP_STOPPED",
        },
        202,
      ),
    records,
  );
  mount();
  await screen.findByRole("heading", { name: "判断対応の終了を記録" });
  expect(screen.getAllByText(/作業時間 未取得/)).toHaveLength(2);
  expect(
    screen.getAllByRole("link", { name: "開始・操作の監査ログ" })[0],
  ).toHaveAttribute("href", `/audit-logs/${i.auditEventId}`);
  fireEvent.change(screen.getByLabelText("終了理由コード"), {
    target: { value: "INSPECTED" },
  });
  fireEvent.click(screen.getByRole("button", { name: "判断対応終了を確認" }));
  expect(
    screen.getByRole("region", { name: "OTA操作の最終確認" }),
  ).toHaveTextContent("停止latch・予約・評価を解除しない");
  confirm();
  await screen.findByText(/判断対応終了を受け付けました/);
  const post = mock.mock.calls.find(([, o]) => o?.method === "POST")!;
  expect(JSON.parse(String(post[1]!.body))).toEqual({
    reason: "INSPECTED",
    outcome: "KEEP_STOPPED",
  });
});
it("handles bad route IDs, incomplete responses and API failures without enabling actions", async () => {
  const mock = serve();
  const invalid = mount("/deployments/not-an-id");
  expect(screen.getByRole("alert")).toHaveTextContent("配信IDの形式が不正");
  expect(mock).not.toHaveBeenCalled();
  invalid.unmount();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ error: "DEPLOYMENT_UNAVAILABLE" }, 503)),
  );
  mount();
  await screen.findByRole("button", { name: "配信情報を再取得" });
  expect(
    screen.queryByRole("button", { name: "配信停止を確認" }),
  ).not.toBeInTheDocument();
});
