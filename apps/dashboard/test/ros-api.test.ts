import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import {
  fetchRosConfiguration,
  fetchRosHealth,
  fetchRosObservations,
  fetchRosExecution,
  fetchRosCancel,
  requestRosCancel,
} from "../src/ros-api.js";
import { rosFixtures, base, deviceId, commandId } from "./ros-fixtures.mjs";

afterEach(() => vi.unstubAllGlobals());
describe("ROS API consumer validation", () => {
  it("rejects malformed and unknown protocol states rather than showing a successful status", async () => {
    const f = rosFixtures();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...f.health, ready: "yes" })),
    );
    await expect(fetchRosHealth(base, deviceId)).rejects.toThrow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...f.execution,
          command: { ...f.execution.command, executionStatus: "DONE" },
        }),
      ),
    );
    await expect(
      fetchRosExecution(base, deviceId, commandId),
    ).rejects.toThrow();
  });
  it("checks device and command scope on observation, health, configuration and execution", async () => {
    const f = rosFixtures();
    for (const [data, request] of [
      [f.config, () => fetchRosConfiguration(base, "other")],
      [f.health, () => fetchRosHealth(base, "other")],
      [[f.sample], () => fetchRosObservations(base, "other")],
      [f.execution, () => fetchRosExecution(base, "other", commandId)],
      [f.cancellation, () => fetchRosCancel(base, "other", commandId)],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(data)),
      );
      await expect(request()).rejects.toThrow(/scope mismatch/);
    }
  });
  it("treats missing execution/cancel separately from network or server failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 404 })),
    );
    expect(await fetchRosExecution(base, deviceId, commandId)).toBeNull();
    expect(await fetchRosCancel(base, deviceId, commandId)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 503 })),
    );
    await expect(
      fetchRosExecution(base, deviceId, commandId),
    ).rejects.toBeInstanceOf(ApiError);
  });
  it("validates reasons before sending and preserves API conflict rejection", async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestRosCancel(base, deviceId, commandId, "same-key", "free text"),
    ).rejects.toThrow(/invalid/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      requestRosCancel(
        base,
        deviceId,
        commandId,
        "same-key",
        "OPERATOR_REQUEST",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([
      `${base}/devices/${deviceId}/commands/${commandId}/cancel`,
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": "same-key" }),
        body: '{"reason":"OPERATOR_REQUEST"}',
      }),
    ]);
  });
});
