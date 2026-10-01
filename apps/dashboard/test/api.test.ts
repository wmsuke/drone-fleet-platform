import { describe, expect, it } from "vitest";

import { normalizeApiBaseUrl } from "../src/api.js";

describe("normalizeApiBaseUrl", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["   ", null],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    [" https://api.example.test/// ", "https://api.example.test"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeApiBaseUrl(input)).toBe(expected);
  });
});
