// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../src/app.js";

function renderApp(apiBaseUrl: string | null, route = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <DashboardApp apiBaseUrl={apiBaseUrl} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DashboardApp", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows loading and empty states", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn(() => request);
    vi.stubGlobal("fetch", fetchMock);

    renderApp("http://api.example.test");

    expect(screen.getByText("機体情報を読み込んでいます…")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example.test/devices",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );

    resolveRequest(new Response("[]", { status: 200 }));
    expect(
      await screen.findByText("登録済みの機体はありません。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("機体数の集計")).toHaveTextContent(
      "総台数0オンライン0オフライン0",
    );
  });

  it("shows an error and retries the request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderApp("http://api.example.test");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "機体情報を取得できませんでした。",
    );
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(
      await screen.findByText("登録済みの機体はありません。"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows fleet totals, device status, telemetry summary, and detail links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                deviceId: "drone-001",
                connectionStatus: "ONLINE",
                battery: 87.5,
                flightStatus: "FLYING",
                lastReceivedAt: "2026-10-01T02:00:00.000Z",
              },
              {
                deviceId: "drone-002",
                connectionStatus: "OFFLINE",
                battery: null,
                flightStatus: null,
                lastReceivedAt: null,
              },
            ]),
            { status: 200 },
          ),
      ),
    );

    renderApp("http://api.example.test");

    expect(await screen.findByText("drone-001")).toBeInTheDocument();
    const summary = within(screen.getByLabelText("機体数の集計"));
    expect(summary.getByText("総台数").parentElement).toHaveTextContent("2");
    expect(summary.getByText("オンライン").parentElement).toHaveTextContent(
      "1",
    );
    expect(summary.getByText("オフライン").parentElement).toHaveTextContent(
      "1",
    );
    expect(screen.getByText("87.5%")).toBeInTheDocument();
    expect(screen.getByText("飛行中")).toBeInTheDocument();
    expect(screen.getByText("未受信")).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: /機体詳細を見る/ })[0],
    ).toHaveAttribute("href", "/devices/drone-001");
    expect(screen.getAllByText("オンライン")).toHaveLength(2);
    expect(screen.getAllByText("オフライン")).toHaveLength(2);
  });

  it("explains how to configure a missing API base URL", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderApp(null);

    expect(screen.getByRole("alert")).toHaveTextContent("VITE_API_BASE_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes device and unknown paths", () => {
    const deviceRoute = renderApp(null, "/devices/drone-001");
    expect(
      screen.getByRole("heading", { name: "drone-001" }),
    ).toBeInTheDocument();

    deviceRoute.unmount();
    renderApp(null, "/unknown");
    expect(
      screen.getByRole("heading", { name: "ページが見つかりません" }),
    ).toBeInTheDocument();
  });

  it("refreshes the device list every five seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderApp("http://api.example.test");
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
