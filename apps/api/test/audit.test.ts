import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { Database } from "@drone-fleet/database";
import { registerAuditHooks } from "../src/audit.js";
afterEach(() => vi.restoreAllMocks());
it("does not mislabel a rejected operation's group ID as an operation target ID", async () => {
  const values = vi.fn(async () => {});
  const db = { insert: () => ({ values }) } as unknown as Database;
  const app = Fastify();
  registerAuditHooks(app, db);
  app.post("/fleet-operations", async (_r, reply) =>
    reply.code(409).send({ error: "rejected" }),
  );
  try {
    const groupId = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
    const response = await app.inject({
      method: "POST",
      url: "/fleet-operations",
      payload: { groupId, type: "REBOOT" },
    });
    expect(response.statusCode).toBe(409);
    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        targetKind: "operation",
        targetId: null,
        groupId,
        operationId: null,
        result: "REJECTED",
      }),
    ]);
  } finally {
    await app.close();
  }
});
it("reports a safe failure counter when rejected-request audit cannot be saved", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const db = {
    insert() {
      throw Error("audit-test-secret");
    },
  } as unknown as Database;
  const app = Fastify();
  registerAuditHooks(app, db);
  app.post("/groups", async (_r, reply) =>
    reply.code(400).send({ error: "invalid" }),
  );
  try {
    const result = await app.inject({
      method: "POST",
      url: "/groups",
      headers: {
        authorization: "Bearer audit-test-secret",
        "x-request-id": "untrusted",
      },
      payload: { private: "audit-test-secret" },
    });
    expect(result.statusCode).toBe(400);
    expect(String(result.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
    const logs = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain('"event":"audit.write_failed"');
    expect(logs).toContain('"failures":1');
    expect(logs).not.toMatch(/audit-test-secret|untrusted/);
  } finally {
    await app.close();
  }
});
