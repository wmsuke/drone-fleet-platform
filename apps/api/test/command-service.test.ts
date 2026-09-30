import { describe, expect, it, vi } from "vitest";

import type { CommandPublisher } from "../src/command-publisher.js";
import type {
  CommandRepository,
  PendingCommand,
} from "../src/command-repository.js";
import {
  CommandPublishError,
  DeviceNotFoundError,
  createCommandService,
} from "../src/command-service.js";
import type { CommandResponse } from "../src/schema.js";

const commandId = "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c";
const createdAt = new Date("2026-09-30T02:00:00.000Z");
const sentAt = new Date("2026-09-30T02:00:01.000Z");

function response(
  status: CommandResponse["status"],
  type: CommandResponse["type"] = "RETURN_HOME",
): CommandResponse {
  return {
    commandId,
    deviceId: "drone-001",
    type,
    status,
    createdAt: createdAt.toISOString(),
    sentAt: status === "SENT" ? sentAt.toISOString() : null,
  };
}

function dependencies() {
  const repository: CommandRepository = {
    createPending: vi.fn(async (command: PendingCommand) => ({
      ...command,
      status: "PENDING" as const,
      createdAt: command.createdAt.toISOString(),
      sentAt: null,
    })),
    markSent: vi.fn(async () => response("SENT")),
    markFailed: vi.fn(async () => response("FAILED")),
    history: vi.fn(async () => []),
  };
  const publisher: CommandPublisher = { publish: vi.fn(async () => undefined) };
  const times = [createdAt, sentAt];
  const service = createCommandService(
    repository,
    publisher,
    () => commandId,
    () => times.shift() ?? sentAt,
  );
  return { publisher, repository, service };
}

describe("createCommandService", () => {
  it("returns command history from the repository", async () => {
    const { repository, service } = dependencies();

    await expect(service.history("drone-001", 100)).resolves.toEqual([]);
    expect(repository.history).toHaveBeenCalledWith("drone-001", 100);
  });

  it.each(["RETURN_HOME", "REBOOT"] as const)(
    "persists, publishes, and marks a %s command sent",
    async (type) => {
      const { publisher, repository, service } = dependencies();

      await expect(service.send("drone-001", type)).resolves.toMatchObject({
        commandId,
        status: "SENT",
      });
      expect(repository.createPending).toHaveBeenCalledWith({
        commandId,
        deviceId: "drone-001",
        type,
        createdAt,
      });
      expect(publisher.publish).toHaveBeenCalledWith({
        schemaVersion: 1,
        commandId,
        deviceId: "drone-001",
        type,
        timestamp: createdAt.toISOString(),
      });
      expect(repository.markSent).toHaveBeenCalledWith(commandId, sentAt);
    },
  );

  it("does not publish when PENDING persistence fails", async () => {
    const { publisher, repository, service } = dependencies();
    vi.mocked(repository.createPending).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(service.send("drone-001", "REBOOT")).rejects.toThrow(
      "database unavailable",
    );
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("rejects an unregistered device without publishing", async () => {
    const { publisher, repository, service } = dependencies();
    vi.mocked(repository.createPending).mockResolvedValueOnce(null);

    await expect(service.send("drone-999", "REBOOT")).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("marks a command failed when MQTT publish fails", async () => {
    const { publisher, repository, service } = dependencies();
    vi.mocked(publisher.publish).mockRejectedValueOnce(
      new Error("broker unavailable"),
    );

    await expect(service.send("drone-001", "RETURN_HOME")).rejects.toEqual(
      new CommandPublishError(response("FAILED")),
    );
    expect(repository.markFailed).toHaveBeenCalledWith(commandId);
    expect(repository.markSent).not.toHaveBeenCalled();
  });

  it("preserves an acknowledgement that arrives before markSent", async () => {
    const { repository, service } = dependencies();
    vi.mocked(repository.markSent).mockResolvedValueOnce(
      response("ACKNOWLEDGED"),
    );

    await expect(
      service.send("drone-001", "RETURN_HOME"),
    ).resolves.toMatchObject({ status: "ACKNOWLEDGED" });
  });
});
