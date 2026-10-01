// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandControls } from "../src/command-controls.js";

function renderControls() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CommandControls
        apiBaseUrl="http://api.example.test"
        deviceId="drone-001"
      />
    </QueryClientProvider>,
  );
}

function commandResponse(type: "RETURN_HOME" | "REBOOT") {
  return new Response(
    JSON.stringify({
      commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
      deviceId: "drone-001",
      type,
      status: "SENT",
      createdAt: "2026-10-01T03:00:00.000Z",
      sentAt: "2026-10-01T03:00:01.000Z",
    }),
    { status: 202 },
  );
}

describe("CommandControls", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("confirms and sends RETURN_HOME once while disabling repeated actions", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn(() => request);
    vi.stubGlobal("fetch", fetchMock);
    renderControls();

    fireEvent.click(screen.getByRole("button", { name: "帰還させる" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "帰還コマンドを送信しますか？",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const confirm = screen.getByRole("button", { name: "帰還を実行" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example.test/devices/drone-001/commands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ type: "RETURN_HOME" }),
      }),
    );
    expect(screen.getByRole("button", { name: "送信中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "再起動する" })).toBeDisabled();

    resolveRequest(commandResponse("RETURN_HOME"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "帰還コマンドを送信しました。状態: SENT",
    );
  });

  it("requires explicit risk acknowledgement before sending REBOOT", async () => {
    const fetchMock = vi.fn(async () => commandResponse("REBOOT"));
    vi.stubGlobal("fetch", fetchMock);
    renderControls();

    fireEvent.click(screen.getByRole("button", { name: "再起動する" }));
    const confirm = screen.getByRole("button", { name: "再起動を実行" });
    expect(confirm).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "再起動により通信が一時切断されることを理解しました",
      }),
    );
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "再起動コマンドを送信しました。",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example.test/devices/drone-001/commands",
      expect.objectContaining({ body: JSON.stringify({ type: "REBOOT" }) }),
    );
  });

  it("shows an API error and keeps the command available for retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    renderControls();

    fireEvent.click(screen.getByRole("button", { name: "帰還させる" }));
    fireEvent.click(screen.getByRole("button", { name: "帰還を実行" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "コマンドを送信できませんでした。",
    );
    expect(screen.getByRole("button", { name: "帰還を実行" })).toBeEnabled();
  });
});
