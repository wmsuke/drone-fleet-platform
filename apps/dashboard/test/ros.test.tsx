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
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RosPage } from "../src/ros.js";
import { RosObservationDetails } from "../src/ros-observation.js";
import { rosFixtures, base, deviceId, commandId } from "./ros-fixtures.mjs";

describe("ROS dashboard evidence and cancellation", () => {
  let f: ReturnType<typeof rosFixtures>;
  let cancelStored = false,
    unavailable = false,
    loseResponse = false;
  let writes: RequestInit[];
  beforeEach(() => {
    sessionStorage.clear();
    f = rosFixtures();
    writes = [];
    cancelStored = unavailable = loseResponse = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input).slice(base.length);
        if (init?.method === "POST") {
          writes.push(init);
          if (loseResponse) throw new TypeError("network lost after commit");
          cancelStored = true;
          return Response.json(
            {
              cancelId: f.cancellation.cancelId,
              replayed: false,
              state: f.cancellation,
            },
            { status: 202 },
          );
        }
        if (unavailable)
          return Response.json({ error: "UNAVAILABLE" }, { status: 503 });
        if (path.includes("/cancel"))
          return Response.json(
            cancelStored ? f.cancellation : { error: "CANCEL_NOT_FOUND" },
            { status: cancelStored ? 200 : 404 },
          );
        if (path.includes("/bridge-execution"))
          return Response.json(f.execution);
        if (path.includes("/bridge-configuration"))
          return Response.json(f.config);
        if (path.includes("/bridge-health")) return Response.json(f.health);
        if (path.includes("/observations")) return Response.json([f.sample]);
        if (path.endsWith("/commands")) return Response.json(f.history);
        throw new Error(`unexpected request ${path}`);
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });
  function page(selected = true) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            `/devices/${deviceId}/ros${selected ? `?commandId=${commandId}` : ""}`,
          ]}
        >
          <Routes>
            <Route
              path="/devices/:deviceId/ros"
              element={<RosPage apiBaseUrl={base} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { ...view, client };
  }
  it("shows local frame, units, quality, versions, progress and unsupported reboot", async () => {
    page();
    expect(await screen.findByText(/Bridge 0.5.0/)).toBeInTheDocument();
    expect(screen.getByText(/LOCAL \/ ENU/)).toHaveTextContent(
      /緯度・経度ではない/,
    );
    expect(screen.getByText(/不明 \(UNKNOWN\)/)).toBeInTheDocument();
    expect(screen.getByText(/2000 mm/)).toHaveTextContent(
      /進捗であり成功ではない/,
    );
    expect(screen.getByText(/ROS受理/)).toBeInTheDocument();
    expect(screen.getAllByText(/停止観測は未確認/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "再起動する" })).toBeDisabled();
    expect(
      screen.getByRole("link", { name: /このcommandの監査/ }),
    ).toHaveAttribute("href", `/audit-logs?commandId=${commandId}`);
    expect(writes).toHaveLength(0);
  });
  it.each(["stale", "equal", "unknown"])(
    "fails closed for %s health/configuration",
    async (kind) => {
      if (kind === "stale") f.health.fresh = false;
      if (kind === "equal")
        f.config.reported!.reportSequence = f.health.latest!.message.sequence;
      if (kind === "unknown") f.config.reported = null;
      page(false);
      await screen.findByRole("heading", { name: "ROS由来の観測値" });
      expect(screen.getByRole("button", { name: "帰還させる" })).toBeDisabled();
      expect(writes).toHaveLength(0);
    },
  );
  it("confirms a reason with keyboard focus, separates acceptance and resumes after reload", async () => {
    const first = page();
    const reason = await screen.findByRole("textbox", {
      name: "中断理由コード",
    });
    fireEvent.change(reason, { target: { value: "OPERATOR_REQUEST" } });
    const trigger = screen.getByRole("button", { name: "中断内容を確認" });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.submit(reason.closest("form")!);
    const send = screen.getByRole("button", { name: "中断要求を送信" });
    expect(send).toHaveFocus();
    fireEvent.keyDown(send, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "中断要求を送信" }));
    expect(
      await screen.findByText("ROSが中断を受付（完了・停止ではない）"),
    ).toBeInTheDocument();
    expect(screen.getByText("中断結果を確認中")).toBeInTheDocument();
    expect(screen.getByText(/費用 未報告/)).toBeInTheDocument();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.body as string)).toEqual({
      reason: "OPERATOR_REQUEST",
    });
    expect(
      (writes[0]!.headers as Record<string, string>)["Idempotency-Key"],
    ).toBeTruthy();
    first.unmount();
    page();
    expect(
      await screen.findByText("ROSが中断を受付（完了・停止ではない）"),
    ).toBeInTheDocument();
    expect(writes).toHaveLength(1);
  });
  it("retains original reason and key after response loss and reload without automatic retry", async () => {
    loseResponse = true;
    const first = page();
    const input = await screen.findByRole("textbox", {
      name: "中断理由コード",
    });
    fireEvent.change(input, { target: { value: "OPERATOR_REQUEST" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "中断内容を確認" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "中断内容を確認" }));
    fireEvent.click(screen.getByRole("button", { name: "中断要求を送信" }));
    await screen.findByText(/中断要求の確認に失敗/);
    first.unmount();
    page();
    const retry = await screen.findByRole("button", {
      name: "同じ中断要求を再確認",
    });
    expect(writes).toHaveLength(1);
    expect(
      screen.getByRole("textbox", { name: "中断理由コード" }),
    ).toHaveAttribute("readonly");
    loseResponse = false;
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "中断要求を送信" }));
    await screen.findByText("ROSが中断を受付（完了・停止ではない）");
    expect(writes).toHaveLength(2);
    expect(writes[1]!.headers).toEqual(writes[0]!.headers);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
  });
  it("revokes operation controls on refresh failure and allows read retry", async () => {
    const { client } = page(false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "帰還させる" })).toBeEnabled(),
    );
    unavailable = true;
    await client.invalidateQueries();
    expect(
      await screen.findByText(/ROS構成・接続を取得できません/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "帰還させる" })).toBeDisabled();
    unavailable = false;
    fireEvent.click(screen.getByRole("button", { name: "ROS接続を再試行" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "帰還させる" })).toBeEnabled(),
    );
  });
  it.each(["UNCERTAIN", "CANCELLED", "SUCCEEDED"] as const)(
    "keeps %s separate from physical stop",
    async (state) => {
      f.execution.command.executionStatus = state;
      f.execution.recovery.humanReviewRequired = true;
      f.execution.recovery.reason = "STOP_UNCONFIRMED";
      cancelStored = true;
      f.cancellation.assessment = "UNCERTAIN";
      f.cancellation.humanReviewRequired = true;
      page();
      expect(
        await screen.findByText(/人間判断待ち: STOP_UNCONFIRMED/),
      ).toBeInTheDocument();
      expect(screen.getByText("中断確認は不確定")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "中断内容を確認" }),
      ).not.toBeInTheDocument();
    },
  );
  it("renders missing and GEODETIC observations without inventing local/GPS values", () => {
    const view = render(<RosObservationDetails observation={null} />);
    expect(screen.getByText(/ROS観測は未受信/)).toBeInTheDocument();
    f.sample.message.payload.position = {
      kind: "GEODETIC",
      latitude: 35,
      longitude: 139,
      altitude: null,
      altitudeReference: "WGS84_ELLIPSOID",
      unit: "m",
    };
    view.rerender(<RosObservationDetails observation={f.sample} />);
    expect(screen.getByText(/WGS84_ELLIPSOID/)).toHaveTextContent("高度 不明");
    expect(screen.queryByText(/LOCAL \/ ENU/)).not.toBeInTheDocument();
  });
});
