import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApi } from "../src/app.js";
import {
  CommandPublishError,
  DeviceNotFoundError,
  type CommandService,
} from "../src/command-service.js";
import type { DeviceRepository } from "../src/repository.js";
import type {
  DeviceDetail,
  DeviceListItem,
  TelemetryHistoryItem,
} from "../src/schema.js";

const apps: ReturnType<typeof buildApi>[] = [];
const commandId = "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c";

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

function commands(
  send: CommandService["send"] = async (deviceId, type) => ({
    commandId,
    deviceId,
    type,
    status: "SENT",
    createdAt: "2026-09-30T02:00:00.000Z",
    sentAt: "2026-09-30T02:00:01.000Z",
  }),
  history: CommandService["history"] = async () => [],
): CommandService {
  return { history, send };
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
    const app = buildApi(repository(expected), commands());
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/devices" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("returns an empty array when no devices are registered", async () => {
    const app = buildApi(repository(), commands());
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
    const app = buildApi({ ...repository(), telemetryHistory }, commands());
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
    const app = buildApi({ ...repository(), telemetryHistory }, commands());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-001/telemetry?limit=1000",
    });

    expect(response.statusCode).toBe(200);
    expect(telemetryHistory).toHaveBeenCalledWith("drone-001", 1000);
  });

  it("returns 404 for an unregistered device", async () => {
    const app = buildApi(repository([], null, null), commands());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-999/telemetry",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "deviceが見つかりません" });
  });

  it("returns 400 for an invalid device ID", async () => {
    const app = buildApi(repository(), commands());
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
      const app = buildApi(repository(), commands());
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
    const app = buildApi(repository([], detail), commands());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-001",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(detail);
  });

  it("returns 404 for an unregistered device", async () => {
    const app = buildApi(repository(), commands());
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
      const app = buildApi(repository(), commands());
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

describe("POST /devices/:deviceId/commands", () => {
  it.each(["RETURN_HOME", "REBOOT"] as const)(
    "accepts a %s command",
    async (type) => {
      const send = vi.fn(commands().send);
      const app = buildApi(repository(), commands(send));
      apps.push(app);

      const response = await app.inject({
        method: "POST",
        url: "/devices/drone-001/commands",
        payload: { type },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        commandId,
        deviceId: "drone-001",
        type,
        status: "SENT",
      });
      expect(send).toHaveBeenCalledWith("drone-001", type);
    },
  );

  it.each([
    [
      "invalid device ID",
      "/devices/invalid.device/commands",
      { type: "REBOOT" },
    ],
    ["invalid type", "/devices/drone-001/commands", { type: "LAND" }],
    [
      "extra field",
      "/devices/drone-001/commands",
      { type: "REBOOT", extra: true },
    ],
  ])("returns 400 for %s", async (_name, url, payload) => {
    const app = buildApi(repository(), commands());
    apps.push(app);

    const response = await app.inject({ method: "POST", url, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "入力が不正です" });
  });

  it("returns 404 for an unregistered device", async () => {
    const send = vi.fn(async () => {
      throw new DeviceNotFoundError();
    });
    const app = buildApi(repository(), commands(send));
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/devices/drone-999/commands",
      payload: { type: "REBOOT" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "deviceが見つかりません" });
  });

  it("returns the failed command when MQTT publish fails", async () => {
    const failed = {
      commandId,
      deviceId: "drone-001",
      type: "REBOOT" as const,
      status: "FAILED" as const,
      createdAt: "2026-09-30T02:00:00.000Z",
      sentAt: null,
    };
    const send = vi.fn(async () => {
      throw new CommandPublishError(failed);
    });
    const app = buildApi(repository(), commands(send));
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/devices/drone-001/commands",
      payload: { type: "REBOOT" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual(failed);
  });

  it("returns 500 when database persistence fails", async () => {
    const app = buildApi(
      repository(),
      commands(async () => {
        throw new Error("database unavailable");
      }),
    );
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/devices/drone-001/commands",
      payload: { type: "RETURN_HOME" },
    });

    expect(response.statusCode).toBe(500);
  });
});

describe("GET /devices/:deviceId/commands", () => {
  const history = [
    {
      commandId,
      deviceId: "drone-001",
      type: "RETURN_HOME" as const,
      status: "ACKNOWLEDGED" as const,
      createdAt: "2026-09-30T02:00:00.000Z",
      sentAt: "2026-09-30T02:00:01.000Z",
      acknowledgementReceivedAt: "2026-09-30T02:00:02.000Z",
      timedOutAt: null,
    },
    {
      commandId: "6761a788-402d-4b44-b1fd-779ced12e54f",
      deviceId: "drone-001",
      type: "REBOOT" as const,
      status: "TIMED_OUT" as const,
      createdAt: "2026-09-30T01:00:00.000Z",
      sentAt: "2026-09-30T01:00:01.000Z",
      acknowledgementReceivedAt: null,
      timedOutAt: "2026-09-30T01:00:30.000Z",
    },
  ];

  it.each(["PENDING", "SENT", "ACKNOWLEDGED", "FAILED", "TIMED_OUT"] as const)(
    "returns a %s command",
    async (status) => {
      const item = {
        ...history[0],
        status,
        acknowledgementReceivedAt:
          status === "ACKNOWLEDGED" ? "2026-09-30T02:00:02.000Z" : null,
        timedOutAt: status === "TIMED_OUT" ? "2026-09-30T02:00:30.000Z" : null,
      };
      const app = buildApi(
        repository(),
        commands(undefined, async () => [item]),
      );
      apps.push(app);

      const response = await app.inject({
        method: "GET",
        url: "/devices/drone-001/commands",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([item]);
    },
  );

  it("returns recent commands with all status timestamps", async () => {
    const commandHistory = vi.fn(async () => history);
    const app = buildApi(repository(), commands(undefined, commandHistory));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-001/commands",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(history);
    expect(commandHistory).toHaveBeenCalledWith("drone-001", 100);
  });

  it("accepts a limit up to 1000", async () => {
    const commandHistory = vi.fn(async () => history);
    const app = buildApi(repository(), commands(undefined, commandHistory));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-001/commands?limit=1000",
    });

    expect(response.statusCode).toBe(200);
    expect(commandHistory).toHaveBeenCalledWith("drone-001", 1000);
  });

  it("returns 404 for an unregistered device", async () => {
    const app = buildApi(
      repository(),
      commands(undefined, async () => null),
    );
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/drone-999/commands",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "deviceが見つかりません" });
  });

  it("returns 400 for an invalid device ID", async () => {
    const app = buildApi(repository(), commands());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/devices/invalid.device/commands",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "deviceIdの形式が不正です" });
  });

  it.each(["0", "1001", "1.5", "-1", "abc", ""])(
    "returns 400 for invalid limit %s",
    async (limit) => {
      const app = buildApi(repository(), commands());
      apps.push(app);

      const response = await app.inject({
        method: "GET",
        url: `/devices/drone-001/commands?limit=${limit}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "limitは1から1000の整数です",
      });
    },
  );
});
