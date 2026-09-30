import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApi } from "../src/app.js";
import type { DeviceRepository } from "../src/repository.js";
import type {
  DeviceDetail,
  DeviceListItem,
  TelemetryHistoryItem,
} from "../src/schema.js";

const apps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function repository(
  list: DeviceListItem[] = [],
  detail: DeviceDetail | null = null,
  history: TelemetryHistoryItem[] | null = [],
): DeviceRepository {
  return {
    list: async () => list,
    findById: async () => detail,
    telemetryHistory: async () => history,
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

describe("GET /devices/:deviceId/telemetry", () => {
  const history = [
    {
      sequence: 2,
      deviceTimestamp: "2026-09-29T02:00:09.000Z",
      receivedAt: "2026-09-29T02:00:10.000Z",
      battery: 80,
      latitude: 35,
      longitude: 139,
      altitude: 20,
      temperature: 25,
      flightStatus: "FLYING" as const,
    },
  ];

  it("returns newest telemetry with the default limit", async () => {
    const telemetryHistory = vi.fn(async () => history);
    const app = buildApi({ ...repository(), telemetryHistory });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-001/telemetry",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(history);
    expect(telemetryHistory).toHaveBeenCalledWith("drone-001", 100);
  });

  it("accepts a limit up to 1000", async () => {
    const telemetryHistory = vi.fn(async () => history);
    const app = buildApi({ ...repository(), telemetryHistory });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-001/telemetry?limit=1000",
    });

    expect(response.statusCode).toBe(200);
    expect(telemetryHistory).toHaveBeenCalledWith("drone-001", 1000);
  });

  it("returns 404 for an unregistered device", async () => {
    const app = buildApi(repository([], null, null));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-999/telemetry",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "deviceが見つかりません" });
  });

  it("returns 400 for an invalid device ID", async () => {
    const app = buildApi(repository());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/invalid.device/telemetry",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "deviceIdの形式が不正です" });
  });

  it.each(["0", "1001", "1.5", "-1", "abc", ""])(
    "returns 400 for invalid limit %s",
    async (limit) => {
      const app = buildApi(repository());
      apps.push(app);

      const response = await app.inject({
        method: "GET",
        url: `/devices/drone-001/telemetry?limit=${limit}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "limitは1から1000の整数です",
      });
    },
  );
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
