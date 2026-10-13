import { describe, expect, it, vi } from "vitest";
import {
  createCommandService,
  DeviceNotFoundError,
} from "../src/command-service.js";
import type { CommandRepository } from "../src/command-repository.js";
describe("queued command service", () => {
  function setup() {
    const repository: CommandRepository = {
      createPending: vi.fn(async (command) => ({
        ...command,
        status: "PENDING",
        createdAt: command.createdAt.toISOString(),
        expiresAt: command.expiresAt?.toISOString(),
        sentAt: null,
      })),
      markSent: vi.fn(),
      markFailed: vi.fn(),
      history: vi.fn(async () => []),
    };
    return {
      repository,
      service: createCommandService(
        repository,
        () => "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
        () => new Date("2026-10-13T00:00:00Z"),
      ),
    };
  }
  it.each(["RETURN_HOME", "REBOOT"] as const)(
    "accepts %s without a broker",
    async (type) => {
      const { repository, service } = setup();
      await expect(service.send("drone-001", type)).resolves.toMatchObject({
        status: "PENDING",
        expiresAt: "2026-10-13T00:00:30.000Z",
        sentAt: null,
      });
      expect(repository.createPending).toHaveBeenCalledTimes(1);
      expect(repository.markSent).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
    },
  );
  it("does not acknowledge a failed database commit", async () => {
    const { repository, service } = setup();
    vi.mocked(repository.createPending).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(service.send("drone-001", "REBOOT")).rejects.toThrow(
      "database unavailable",
    );
  });
  it("rejects unknown devices", async () => {
    const { repository, service } = setup();
    vi.mocked(repository.createPending).mockResolvedValueOnce(null);
    await expect(service.send("unknown", "REBOOT")).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
  });
  it("reads command history", async () => {
    const { service } = setup();
    await expect(service.history("drone-001", 100)).resolves.toEqual([]);
  });
});
