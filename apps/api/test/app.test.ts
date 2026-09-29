import { afterEach, describe, expect, it } from "vitest";

import { buildApi } from "../src/app.js";
import type { DeviceListRepository } from "../src/repository.js";

const apps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("GET /devices", () => {
  it("returns registered devices", async () => {
    const expected = [
      {
        deviceId: "drone-001",
        connectionStatus: "ONLINE" as const,
        battery: 87.5,
        flightStatus: "FLYING" as const,
        lastReceivedAt: "2026-09-29T02:00:00.000Z",
      },
      {
        deviceId: "drone-002",
        connectionStatus: "OFFLINE" as const,
        battery: null,
        flightStatus: null,
        lastReceivedAt: null,
      },
    ];
    const repository: DeviceListRepository = { list: async () => expected };
    const app = buildApi(repository);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/devices" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("returns an empty array when no devices are registered", async () => {
    const app = buildApi({ list: async () => [] });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/devices" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
