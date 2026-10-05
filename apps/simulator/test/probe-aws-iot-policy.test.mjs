import { describe, expect, it } from "vitest";

import {
  expectRejected,
  ProbeTimeoutError,
} from "../scripts/probe-aws-iot-policy.mjs";

describe("expectRejected", () => {
  it("operationの明示的な失敗を拒否成功として扱う", async () => {
    await expect(
      expectRejected(
        () => Promise.reject(new Error("connection rejected")),
        "connection",
        50,
      ),
    ).resolves.toBeUndefined();
  });

  it("応答がない場合はtimeout失敗として扱う", async () => {
    await expect(
      expectRejected(() => new Promise(() => {}), "connection", 10),
    ).rejects.toBeInstanceOf(ProbeTimeoutError);
  });

  it("operationが成功した場合は拒否未確認として失敗する", async () => {
    await expect(
      expectRejected(() => Promise.resolve(), "connection", 50),
    ).rejects.toThrow("connection was unexpectedly allowed");
  });
});
