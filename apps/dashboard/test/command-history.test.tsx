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
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandHistory } from "../src/command-history.js";

function renderHistory() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CommandHistory
        apiBaseUrl="http://api.example.test"
        deviceId="drone-001"
      />
    </QueryClientProvider>,
  );
}

function historyResponse(status: "SENT" | "ACKNOWLEDGED" = "ACKNOWLEDGED") {
  return new Response(
    JSON.stringify([
      {
        commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
        deviceId: "drone-001",
        type: "RETURN_HOME",
        status,
        createdAt: "2026-10-01T03:00:00.000Z",
        sentAt: "2026-10-01T03:00:01.000Z",
        acknowledgementReceivedAt:
          status === "ACKNOWLEDGED" ? "2026-10-01T03:00:02.000Z" : null,
        timedOutAt: null,
      },
    ]),
    { status: 200 },
  );
}

describe("CommandHistory", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows command type, status, creation time, and ACK time as text", async () => {
    const fetchMock = vi.fn(async () => historyResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderHistory();

    expect(await screen.findByText("帰還")).toBeInTheDocument();
    expect(screen.getByText("ACK受信済み")).toBeInTheDocument();
    expect(screen.getByText("作成時刻")).toBeInTheDocument();
    expect(screen.getByText("ACK受信時刻")).toBeInTheDocument();
    expect(screen.getAllByRole("time")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example.test/devices/drone-001/commands",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("shows an empty state when the device has no command history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );

    renderHistory();

    expect(
      await screen.findByText("コマンド履歴はまだありません。"),
    ).toBeInTheDocument();
  });

  it("shows a communication error and can retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(historyResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderHistory();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "コマンド履歴を取得できませんでした。",
    );
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText("ACK受信済み")).toBeInTheDocument();
  });

  it("refreshes SENT to ACKNOWLEDGED every five seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(historyResponse("SENT"))
      .mockResolvedValueOnce(historyResponse("ACKNOWLEDGED"));
    vi.stubGlobal("fetch", fetchMock);

    renderHistory();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("送信済み・ACK待ち")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(5_001));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("ACK受信済み")).toBeInTheDocument();
  });
});
