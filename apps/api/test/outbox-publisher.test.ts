import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("mqtt", () => ({ connect: mocks.connect }));
import { createOutboxPublisher } from "../src/outbox-publisher.js";

describe("bounded outbox MQTT publish", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  function setup(url = "mqtt://localhost:1883", clientOptions = {}) {
    const client = Object.assign(new EventEmitter(), {
      publish: vi.fn((_topic, _payload, _options, callback) => callback()),
      end: vi.fn((_force, _options, callback) => callback()),
    });
    mocks.connect.mockReturnValue(client);
    return {
      client,
      publish: createOutboxPublisher({ url, clientOptions }, 1000),
    };
  }
  it.each([
    "mqtt://localhost:1883",
    "mqtts://example.iot.ap-southeast-2.amazonaws.com:8883",
  ])("publishes unchanged QoS1 payload through %s", async (url) => {
    const { client, publish } = setup(url, {
      clientId: "api-fixed",
      ca: Buffer.from("dummy-ca"),
      cert: Buffer.from("dummy-cert"),
      key: Buffer.from("dummy-key"),
      rejectUnauthorized: true,
    });
    const pending = publish("topic", "payload", new Date(Date.now() + 30000));
    client.emit("connect");
    await pending;
    expect(mocks.connect).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        clientId: "api-fixed",
        reconnectPeriod: 0,
        rejectUnauthorized: true,
        cert: Buffer.from("dummy-cert"),
      }),
    );
    expect(client.publish).toHaveBeenCalledWith(
      "topic",
      "payload",
      { qos: 1, retain: false },
      expect.any(Function),
    );
    expect(client.end).toHaveBeenCalledWith(true, {}, expect.any(Function));
  });
  it("does not connect for an expired command", async () => {
    const { publish } = setup();
    await expect(publish("topic", "payload", new Date(0))).rejects.toThrow(
      "expired",
    );
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("destroys timed-out sessions and does not publish after late connect", async () => {
    vi.useFakeTimers();
    const { client, publish } = setup();
    const assertion = expect(
      publish("topic", "payload", new Date(Date.now() + 500)),
    ).rejects.toThrow("publish failed");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    client.emit("connect");
    expect(client.publish).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });
  it("redacts MQTT errors", async () => {
    const { client, publish } = setup();
    const assertion = expect(
      publish("topic", "payload", new Date(Date.now() + 1000)),
    ).rejects.toThrow(/^command publish failed$/);
    client.emit("error", new Error("secret key path"));
    await assertion;
  });
});
