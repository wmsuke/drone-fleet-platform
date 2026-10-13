// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardApp } from "../src/app.js";
import type { Group } from "../src/groups-api.js";

const id = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
function group(deviceIds: string[] = []): Group {
  return {
    groupId: id,
    name: "訓練隊",
    description: null,
    revision: 1,
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    deviceCount: deviceIds.length,
    deviceIds,
  };
}
function device(deviceId: string, connectionStatus = "ONLINE") {
  return {
    deviceId,
    connectionStatus,
    battery: null,
    flightStatus: null,
    lastReceivedAt: null,
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function mount(route = "/groups", base: string | null = "http://api.test") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <DashboardApp apiBaseUrl={base} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("group dashboard", () => {
  it("retries a failed group list", async () => {
    let failed = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/devices") ? json([]) : failed ? json({}, 503) : json([]),
      ),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "グループを取得できませんでした",
    );
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "最新状態を再取得" }));
    expect(
      await screen.findByText("グループはありません。"),
    ).toBeInTheDocument();
  });
  it("cancels confirmation with Escape and requires a new confirmation after network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === "POST") throw new Error("offline");
        return url.endsWith("/devices")
          ? json([device("drone-1")])
          : json(group());
      }),
    );
    mount(`/groups/${id}`);
    fireEvent.click(
      await screen.findByRole("button", { name: "drone-1を追加" }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "キャンセル" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "訓練隊" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "drone-1を追加" }));
    fireEvent.click(screen.getByRole("button", { name: "確定する" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "変更済みの可能性",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows empty groups, loading and missing configuration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json([])),
    );
    mount();
    expect(screen.getByText("グループを読み込んでいます…")).toBeInTheDocument();
    expect(
      await screen.findByText("グループはありません。"),
    ).toBeInTheDocument();
    cleanup();
    mount("/groups", null);
    expect(screen.getByRole("alert")).toHaveTextContent("VITE_API_BASE_URL");
  });
  it("shows group counts and links, without treating unknown devices as offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/devices")
          ? json([device("drone-1"), device("drone-2", "OFFLINE")])
          : json([group(["drone-1", "drone-2", "missing"])]),
      ),
    );
    mount();
    expect(await screen.findByRole("link", { name: "訓練隊" })).toHaveAttribute(
      "href",
      `/groups/${id}`,
    );
    expect(
      await screen.findByText(
        "所属 3台 / ONLINE 1台 / OFFLINE 1台 / 状態未取得 1台",
      ),
    ).toBeInTheDocument();
  });
  it("creates only after confirmation, supports cancel and restores focus", async () => {
    let created = false;
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        created = true;
        return json(group(), 201);
      }
      return json(created ? [group()] : []);
    });
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await screen.findByText("グループはありません。");
    fireEvent.change(screen.getByLabelText("グループ名"), {
      target: { value: " 訓練隊 " },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "作成内容を確認" }).closest("form")!,
    );
    expect(screen.getByRole("button", { name: "キャンセル" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(created).toBe(false);
    expect(screen.getByRole("heading", { name: "機体グループ" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "作成内容を確認" }));
    fireEvent.click(screen.getByRole("button", { name: "確定する" }));
    expect(
      await screen.findByText("「訓練隊」を作成しました。"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/groups",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "訓練隊" }),
      }),
    );
  });
  it("renames, adds and removes members, then confirms group deletion", async () => {
    let current = group(["drone-1"]);
    let deleted = false;
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "http://api.test/devices")
        return json([device("drone-1"), device("drone-2", "OFFLINE")]);
      if (options?.method === "PATCH") {
        current = { ...current, name: "点検隊" };
        return json(current);
      }
      if (options?.method === "POST") {
        current = {
          ...current,
          deviceIds: ["drone-1", "drone-2"],
          deviceCount: 2,
        };
        return json(current, 201);
      }
      if (options?.method === "DELETE") {
        if (url.endsWith("/devices/drone-1"))
          current = { ...current, deviceIds: ["drone-2"], deviceCount: 1 };
        else deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/groups")) return json(deleted ? [] : [current]);
      return deleted ? json({}, 404) : json(current);
    });
    vi.stubGlobal("fetch", fetchMock);
    mount(`/groups/${id}`);
    await screen.findByRole("heading", { name: "訓練隊" });
    fireEvent.change(screen.getByLabelText("グループ名"), {
      target: { value: "点検隊" },
    });
    fireEvent.click(screen.getByRole("button", { name: "名称変更を確認" }));
    fireEvent.click(screen.getByRole("button", { name: "確定する" }));
    await screen.findByRole("heading", { name: "点検隊" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "drone-2を追加" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "drone-2を追加" }));
    fireEvent.click(screen.getByRole("button", { name: "確定する" }));
    await screen.findByText("drone-2を追加しました。");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "drone-1の所属を解除" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "drone-1の所属を解除" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "機体そのものは削除しません",
    );
    fireEvent.click(screen.getByRole("button", { name: "確定する" }));
    await screen.findByText("drone-1の所属を解除しました。");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "グループを削除" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "グループを削除" }));
    expect(deleted).toBe(false);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "通常の一覧から非表示",
    );
    fireEvent.click(screen.getByRole("button", { name: "確定する" }));
    await screen.findByText("グループはありません。");
    expect(screen.getByText("「点検隊」を削除しました。")).toBeInTheDocument();
  });
  it("reports conflicts and reloads the latest membership before another action", async () => {
    let changed = false;
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/devices") && options?.method !== "POST")
        return json([device("drone-1")]);
      if (options?.method === "POST") {
        changed = true;
        return json({}, 409);
      }
      return json(group(changed ? ["drone-1"] : []));
    });
    vi.stubGlobal("fetch", fetchMock);
    mount(`/groups/${id}`);
    fireEvent.click(
      await screen.findByRole("button", { name: "drone-1を追加" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "確定する" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "最新状態を再取得",
    );
    await screen.findByRole("button", { name: "drone-1の所属を解除" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "最新状態を再取得" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => url === `http://api.test/groups/${id}`,
        ).length,
      ).toBeGreaterThanOrEqual(3),
    );
  });
  it("disables repeated submissions while a request is pending", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === "POST")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return url.endsWith("/devices")
        ? json([device("drone-1")])
        : json(group());
    });
    vi.stubGlobal("fetch", fetchMock);
    mount(`/groups/${id}`);
    fireEvent.click(
      await screen.findByRole("button", { name: "drone-1を追加" }),
    );
    const confirm = screen.getByRole("button", { name: "確定する" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(
      await screen.findByRole("button", { name: "送信中…" }),
    ).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
    await act(async () => finish(json(group(["drone-1"]), 201)));
  });
  it("shows 404, API errors and an empty membership", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/devices") ? json([], 503) : json({}, 404),
      ),
    );
    mount(`/groups/${id}`);
    expect(
      await screen.findByText(/グループが見つかりません/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/機体一覧を取得できません/),
    ).toBeInTheDocument();
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/devices") ? json([]) : json(group()),
      ),
    );
    mount(`/groups/${id}`);
    expect(
      await screen.findByText("所属機体はありません。"),
    ).toBeInTheDocument();
  });
  it("limits candidate DOM rows and searches across all devices", async () => {
    const devices = Array.from({ length: 120 }, (_, index) =>
      device(`drone-${String(index).padStart(3, "0")}`),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/devices") ? json(devices) : json(group()),
      ),
    );
    mount(`/groups/${id}`);
    const candidates = await screen.findByRole("region", {
      name: "追加候補一覧",
    });
    await waitFor(() =>
      expect(within(candidates).getAllByRole("listitem")).toHaveLength(50),
    );
    fireEvent.click(within(candidates).getByRole("button", { name: "次へ" }));
    expect(within(candidates).getByText("2 / 3ページ")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("機体IDを検索"), {
      target: { value: "119" },
    });
    expect(
      within(screen.getByRole("region", { name: "追加候補一覧" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "drone-119を追加" }),
    ).toBeInTheDocument();
  });
});
