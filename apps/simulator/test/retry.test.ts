import { describe, expect, it } from "vitest";

import { retryDelayMs } from "../src/retry.js";

describe("retryDelayMs", () => {
  it("grows exponentially, caps the delay, and applies jitter", () => {
    expect(retryDelayMs(0, 1000, 4000, () => 1)).toBe(1000);
    expect(retryDelayMs(1, 1000, 4000, () => 1)).toBe(2000);
    expect(retryDelayMs(2, 1000, 4000, () => 1)).toBe(4000);
    expect(retryDelayMs(12, 1000, 4000, () => 1)).toBe(4000);
    expect(retryDelayMs(1, 1000, 4000, () => 0)).toBe(1000);
  });
});
