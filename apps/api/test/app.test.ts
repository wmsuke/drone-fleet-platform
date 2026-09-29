import { afterEach, describe, expect, it } from "vitest";

import { buildApi } from "../src/app.js";
import type { DeviceRepository } from "../src/repository.js";
import type { DeviceDetail, DeviceListItem } from "../src/schema.js";

const apps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function repository(
  list: DeviceListItem[] = [],
  detail: DeviceDetail | null = null,
): DeviceRepository {
  return {
    list: async () => list,
    findById: async () => detail,
  };
}

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
    const app = buildApi(repository(expected));
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/devices" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("returns an empty array when no devices are registered", async () => {
    const app = buildApi(repository());
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/devices" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe("GET /devices/:deviceId", () => {
  const detail = {
    deviceId: "drone-001",
    model: "virtual-drone",
    softwareVersion: "1.0.0",
    connectionStatus: "ONLINE" as const,
    lastReceivedAt: "2026-09-29T02:00:10.000Z",
    createdAt: "2026-09-29T01:00:00.000Z",
    updatedAt: "2026-09-29T02:00:10.000Z",
    latestTelemetry: {
      sequence: 12,
      deviceTimestamp: "2026-09-29T02:00:09.000Z",
      receivedAt: "2026-09-29T02:00:10.000Z",
      battery: 87.5,
      latitude: 35.681236,
      longitude: 139.767125,
      altitude: 20,
      temperature: 25,
      flightStatus: "FLYING" as const,
    },
  };

  it("returns the device and its latest telemetry", async () => {
    const app = buildApi(repository([], detail));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-001",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(detail);
  });

  it("returns 404 for an unregistered device", async () => {
    const app = buildApi(repository());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-999",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "deviceが見つかりません" });
  });

  it.each(["invalid.device", "a".repeat(65)])(
    "returns 400 for invalid device ID %s",
    async (deviceId) => {
      const app = buildApi(repository());
      apps.push(app);

      const response = await app.inject({
        method: "GET",
        url: `/devices/${deviceId}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "deviceIdの形式が不正です" });
    },
  );
});
