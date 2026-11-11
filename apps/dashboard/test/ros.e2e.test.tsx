// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { DashboardApp } from "../src/app.js";
import {
  fetchRosCancel,
  fetchRosExecution,
  fetchRosObservations,
} from "../src/ros-api.js";
import { fetchCommandHistory } from "../src/api.js";

it.skipIf(process.env.ROS_E2E_UI !== "true")(
  "実ROS/DDS/MQTT/DB/APIからReact画面まで状態を追跡する",
  async () => {
    configure({ asyncUtilTimeout: 20000 });
    const base = "http://api:3000",
      device = process.env.ROS_E2E_DEVICE!,
      mode = process.env.ROS_E2E_UI_MODE!;
    let commandId = process.env.ROS_E2E_COMMAND_ID;
    if (
      !/^ros-[a-z0-9-]+$/.test(device) ||
      !["success", "cancel", "uncertain", "live"].includes(mode)
    )
      throw new Error("dedicated ROS E2E scope required");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    async function eventually<T>(
      read: () => Promise<T | false>,
      timeout = 30000,
    ): Promise<T> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const v = await read();
        if (v !== false) return v;
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error("bounded real ROS UI observation wait expired");
    }
    const click = async (name: string) => {
      const button = await screen.findByRole("button", { name });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
    };
    try {
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter
            initialEntries={[
              `/devices/${device}/ros${commandId ? `?commandId=${commandId}` : ""}`,
            ]}
          >
            <DashboardApp apiBaseUrl={base} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(await screen.findByText(/Bridge 0.5.0/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "再起動する" })).toBeDisabled();
      const sample = await fetchRosObservations(base, device);
      expect(sample?.[0]?.message.deviceId).toBe(device);
      await screen.findByText(/LOCAL \/ ENU/);
      if (mode === "live") {
        const previous = await fetchCommandHistory(base, device);
        expect(previous).toHaveLength(0);
        await click("帰還させる");
        await click("帰還を実行");
        const created = await eventually(async () => {
          const rows = await fetchCommandHistory(base, device);
          return rows.length === 1 ? rows[0]! : false;
        });
        commandId = created.commandId;
        await act(async () => {
          await client.invalidateQueries({ queryKey: ["commands", device] });
        });
        fireEvent.change(await screen.findByLabelText("追跡するcommand"), {
          target: { value: commandId },
        });
        const original = await eventually(async () => {
          const s = await fetchRosExecution(base, device, commandId!);
          return s?.target.acceptedAt ? s : false;
        });
        expect(original.command.executionStatus).toBe("NOT_REPORTED");
        expect(original.target.stopConfirmed).toBe(false);
        await act(async () => {
          await client.invalidateQueries({
            queryKey: ["ros-execution", base, device, commandId],
          });
        });
        fireEvent.change(await screen.findByLabelText("中断理由コード"), {
          target: { value: "OPERATOR_REQUEST" },
        });
        await click("中断内容を確認");
        expect(screen.getByRole("dialog")).toHaveTextContent(
          original.target.goalId!,
        );
        await click("中断要求を送信");
        const accepted = await eventually(async () => {
          const s = await fetchRosCancel(base, device, commandId!);
          return s?.phase === "ACCEPTED" ? s : false;
        });
        expect(accepted.assessment).toBe("PENDING");
        expect(accepted.stopConfirmation).toBe("UNKNOWN");
        expect(accepted.request.goalId).toBe(original.target.goalId);
        await act(async () => {
          await client.invalidateQueries({
            queryKey: ["ros-cancel", base, device, commandId],
          });
        });
        expect(
          await screen.findByText("ROSが中断を受付（完了・停止ではない）"),
        ).toBeInTheDocument();
        const uncertain = await eventually(async () => {
          const s = await fetchRosCancel(base, device, commandId!);
          return s?.assessment === "UNCERTAIN" ? s : false;
        });
        await act(async () => {
          await client.invalidateQueries({
            queryKey: ["ros-cancel", base, device, commandId],
          });
        });
        expect(await screen.findByText("中断確認は不確定")).toBeInTheDocument();
        expect(uncertain.humanReviewRequired).toBe(true);
        expect(uncertain.stopConfirmation).toBe("UNKNOWN");
        const after = await fetchRosExecution(base, device, commandId!);
        expect(after?.target.goalId).toBe(original.target.goalId);
        expect(after?.target.stopConfirmed).toBe(false);
      } else {
        const details = await screen.findByRole("region", {
          name: "ROS実行の詳細",
        });
        const actual = await fetchRosExecution(base, device, commandId!);
        expect(actual?.command.deviceId).toBe(device);
        const label = {
          success: "実行成功",
          cancel: "実行中断の終端",
          uncertain: "実行結果不明",
        }[mode as "success" | "cancel" | "uncertain"];
        expect(
          await within(details).findByText(new RegExp(`実行結果: ${label}`)),
        ).toBeInTheDocument();
        expect(details).toHaveTextContent(actual!.target.goalId!);
        if (mode === "success") {
          expect(actual?.target.stopConfirmed).toBe(true);
          expect(
            actual?.events.some((e) => e.message.kind === "FEEDBACK"),
          ).toBe(true);
          expect(details).toHaveTextContent("進捗であり成功ではない");
        }
        if (mode === "cancel") {
          const cancel = await fetchRosCancel(base, device, commandId!);
          expect(cancel?.assessment).toBe("CANCELLED");
          expect(await screen.findByText(/介入ID/)).toHaveTextContent(
            cancel!.intervention.interventionId,
          );
          expect(
            screen.getByRole("link", { name: /このcommandの監査/ }),
          ).toHaveAttribute("href", `/audit-logs?commandId=${commandId}`);
        }
        if (mode === "uncertain") {
          expect(actual?.recovery.humanReviewRequired).toBe(true);
          expect(
            await screen.findByText(/人間判断待ち: SERVER_CHANGED/),
          ).toBeInTheDocument();
          expect(actual?.target.stopConfirmed).toBe(false);
        }
      }
      const execution = await fetchRosExecution(base, device, commandId!);
      const cancellation = await fetchRosCancel(base, device, commandId!);
      await writeFile(
        process.env.ROS_E2E_UI_REPORT!,
        JSON.stringify(
          {
            status: "PASSED",
            mode,
            deviceId: device,
            commandId,
            goalId: execution!.target.goalId,
            executionStatus: execution!.command.executionStatus,
            stopConfirmed: execution!.target.stopConfirmed,
            cancelId: cancellation?.cancelId ?? null,
            interventionId: cancellation?.intervention.interventionId ?? null,
            observedAt: new Date().toISOString(),
            mockedTransports: false,
            renderer: "React/jsdom with native HTTP fetch",
          },
          null,
          2,
        ),
      );
    } finally {
      cleanup();
      client.clear();
    }
  },
  120000,
);
