// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeviceDetailPage } from "../src/device-detail.js";

function renderDetail(apiBaseUrl: string | null = "http://api.example.test") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/devices/drone-001"]}>
        <Routes>
          <Route
            path="/devices/:deviceId"
            element={<DeviceDetailPage apiBaseUrl={apiBaseUrl} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function deviceResponse(latestTelemetry: object | null = telemetry) {
  return new Response(
    JSON.stringify({
      deviceId: "drone-001",
      model: "virtual-drone",
      softwareVersion: "1.0.0",
      connectionStatus: "ONLINE",
      lastReceivedAt: "2026-10-01T02:00:01.000Z",
      createdAt: "2026-10-01T01:00:00.000Z",
      updatedAt: "2026-10-01T02:00:01.000Z",
      latestTelemetry,
    }),
    { status: 200 },
  );
}

const telemetry = {
  sequence: 12,
  deviceTimestamp: "2026-10-01T02:00:00.000Z",
  receivedAt: "2026-10-01T02:00:01.000Z",
  battery: 87.5,
  latitude: 35.681236,
  longitude: 139.767125,
  altitude: 24.5,
  temperature: 26.4,
  flightStatus: "FLYING",
};

describe("DeviceDetailPage", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the target device status and latest telemetry with units", async () => {
    const fetchMock = vi.fn(async () => deviceResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderDetail();

    expect(screen.getByText("機体情報を読み込んでいます…")).toBeInTheDocument();
    expect(await screen.findByText("virtual-drone")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example.test/devices/drone-001",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(screen.getByText("オンライン")).toBeInTheDocument();
    expect(screen.getByText("87.5 %")).toBeInTheDocument();
    expect(screen.getByText("飛行中")).toBeInTheDocument();
    expect(screen.getByText("35.681236°")).toBeInTheDocument();
    expect(screen.getByText("139.767125°")).toBeInTheDocument();
    expect(screen.getByText("24.5 m")).toBeInTheDocument();
    expect(screen.getByText("26.4 ℃")).toBeInTheDocument();
    expect(screen.getByText(/計測時刻:/).querySelector("time")).toHaveAttribute(
      "datetime",
      telemetry.deviceTimestamp,
    );
    expect(
      screen.getByRole("link", { name: "← 機体一覧へ戻る" }),
    ).toHaveAttribute("href", "/");
  });

  it("shows a device even when telemetry has not arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => deviceResponse(null)),
    );

    renderDetail();

    expect(
      await screen.findByText("テレメトリはまだありません。"),
    ).toBeInTheDocument();
    expect(screen.getByText("オンライン")).toBeInTheDocument();
  });

  it("distinguishes a missing device from a communication failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(deviceResponse());
    vi.stubGlobal("fetch", fetchMock);

    const missing = renderDetail();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "機体が見つかりません。",
    );
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();

    missing.unmount();
    renderDetail();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "機体情報を取得できませんでした。",
    );
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText("virtual-drone")).toBeInTheDocument();
  });

  it("refreshes the detail every five seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => deviceResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderDetail();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
