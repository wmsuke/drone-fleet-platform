import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { Database } from "@drone-fleet/database";
import { registerAuditHooks } from "../src/audit.js";
afterEach(() => vi.restoreAllMocks());
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
