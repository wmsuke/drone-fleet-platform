import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createShutdown } from "../src/shutdown.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createShutdown", () => {
  it("waits for an in-flight request before closing MQTT and the database", async () => {
    const requestCompleted = deferred();
    const closeStarted = deferred();
    const events: string[] = [];
    const app = {
      close: vi.fn(async () => {
        events.push("http-close-started");
        closeStarted.resolve();
        await requestCompleted.promise;
        events.push("command-published-and-marked-sent");
      }),
    };
    const mqttClient = {
      endAsync: vi.fn(async () => {
        events.push("mqtt-closed");
      }),
    };
    const databaseClient = {
      end: vi.fn(async () => {
        events.push("database-closed");
      }),
    };
    const shutdown = createShutdown(app, mqttClient, databaseClient);

    const firstShutdown = shutdown();
    const secondShutdown = shutdown();
    await closeStarted.promise;

    expect(secondShutdown).toBe(firstShutdown);
    expect(mqttClient.endAsync).not.toHaveBeenCalled();
    expect(databaseClient.end).not.toHaveBeenCalled();

    requestCompleted.resolve();
    await firstShutdown;

    expect(mqttClient.endAsync).toHaveBeenCalledWith(false);
    expect(databaseClient.end).toHaveBeenCalledOnce();
    expect(events.slice(0, 2)).toEqual([
      "http-close-started",
      "command-published-and-marked-sent",
    ]);
    expect(events.slice(2).sort()).toEqual(["database-closed", "mqtt-closed"]);
  });

  it("closes all resources when the HTTP server has not started listening", async () => {
    const app = Fastify();
    const mqttClient = { endAsync: vi.fn(async () => undefined) };
    const databaseClient = { end: vi.fn(async () => undefined) };

    await createShutdown(app, mqttClient, databaseClient)();

    expect(mqttClient.endAsync).toHaveBeenCalledWith(false);
    expect(databaseClient.end).toHaveBeenCalledOnce();
  });
});
