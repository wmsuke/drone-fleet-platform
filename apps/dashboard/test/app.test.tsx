// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    vi.unstubAllGlobals();
  });

  it("shows loading and success states while checking the API", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.fn(() => request);
    vi.stubGlobal("fetch", fetchMock);

    renderApp("http://api.example.test");

    expect(screen.getByText("APIへ接続しています…")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example.test/devices",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );

    resolveRequest(new Response("[]", { status: 200 }));
    expect(
      await screen.findByText("APIへ接続できました。"),
    ).toBeInTheDocument();
  });

  it("shows a helpful error when the API request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    renderApp("http://api.example.test");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "APIへ接続できませんでした。",
    );
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
});
