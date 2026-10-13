import { describe, expect, it } from "vitest";
import { loadOutboxOptions, retryDelay } from "../src/command-outbox.js";
describe("outbox settings", () => {
  it("bounds exponential retry with jitter", () => {
    const options = loadOutboxOptions({});
    expect(retryDelay(1, options, () => 0)).toBe(500);
    expect(retryDelay(2, options, () => 0.5)).toBe(1500);
    expect(retryDelay(100, options, () => 0.5)).toBe(6000);
  });
  it.each(["0", "-1", "NaN", "1.5", "2147483648"])(
    "rejects invalid values %s",
    (value) => {
      expect(() =>
        loadOutboxOptions({ COMMAND_OUTBOX_MAX_ATTEMPTS: value }),
      ).toThrow();
    },
  );
  it("rejects reversed backoff bounds", () => {
    expect(() =>
      loadOutboxOptions({ COMMAND_OUTBOX_RETRY_BASE_MS: "9000" }),
    ).toThrow();
  });
});
