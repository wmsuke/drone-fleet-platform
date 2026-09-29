import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config.js";

describe("loadApiConfig", () => {
  it("uses local defaults", () => {
    expect(loadApiConfig({})).toEqual({ host: "127.0.0.1", port: 3000 });
  });

  it("reads host and port", () => {
    expect(loadApiConfig({ API_HOST: "0.0.0.0", API_PORT: "4000" })).toEqual({
      host: "0.0.0.0",
      port: 4000,
    });
  });

  it.each(["0", "65536", "3000.5", "invalid"])(
    "rejects invalid port %s",
    (port) => {
      expect(() => loadApiConfig({ API_PORT: port })).toThrow(TypeError);
    },
  );
});
