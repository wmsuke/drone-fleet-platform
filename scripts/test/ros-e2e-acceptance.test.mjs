import { expect, it } from "vitest";
import { acceptFleetOperation } from "../ros-e2e-acceptance.mjs";

const ready = { status: 200, body: { ready: true, fresh: true } };
const options = (api, more = {}) => ({
  api,
  devices: ["a", "b"],
  groupId: "group",
  key: "fixed-key",
  pollMs: 0,
  ...more,
});
it("waits for both fresh targets and retries only explicit pre-acceptance rejection with the same request", async () => {
  let reads = 0;
  const posts = [];
  const r = await acceptFleetOperation(
    options(async (path, body, extra) => {
      if (path !== "/fleet-operations") {
        reads++;
        return reads <= 2 && path.includes("/b/")
          ? { status: 200, body: { ready: false, fresh: false } }
          : ready;
      }
      posts.push({ body, headers: extra.headers, reads });
      return posts.length === 1
        ? { status: 409, body: { error: "ROS_HEALTH_UNAVAILABLE" } }
        : { status: 202, body: { operationId: "one" } };
    }),
  );
  expect(r.body.operationId).toBe("one");
  expect(r.acceptance.attempts).toBe(2);
  expect(posts[0].reads).toBeGreaterThanOrEqual(4);
  expect(posts[0].body).toEqual(posts[1].body);
  expect(posts.every((p) => p.headers["Idempotency-Key"] === "fixed-key")).toBe(
    true,
  );
});
it("never repeats a POST when its response is unknown", async () => {
  let posts = 0;
  const unknown = Error("response lost after possible acceptance");
  await expect(
    acceptFleetOperation(
      options(async (path) => {
        if (path !== "/fleet-operations") return ready;
        posts++;
        throw unknown;
      }),
    ),
  ).rejects.toBe(unknown);
  expect(posts).toBe(1);
});
it("does not retry idempotency conflict or unrelated HTTP failure", async () => {
  for (const response of [
    { status: 409, body: { error: "IDEMPOTENCY_CONFLICT" } },
    { status: 500, body: { error: "SERVER_ERROR" } },
  ]) {
    let posts = 0;
    await expect(
      acceptFleetOperation(
        options(async (path) => {
          if (path !== "/fleet-operations") return ready;
          posts++;
          return response;
        }),
      ),
    ).rejects.toThrow("not accepted");
    expect(posts).toBe(1);
  }
});
it("bounds retry attempts without creating a new key", async () => {
  const keys = [];
  await expect(
    acceptFleetOperation(
      options(
        async (path, body, extra) => {
          if (path !== "/fleet-operations") return ready;
          keys.push(extra.headers["Idempotency-Key"]);
          return { status: 409, body: { error: "ROS_HEALTH_UNAVAILABLE" } };
        },
        { maxAttempts: 2 },
      ),
    ),
  ).rejects.toThrow("attempts=2");
  expect(keys).toEqual(["fixed-key", "fixed-key"]);
});
it("does not submit after the deadline", async () => {
  let calls = 0;
  await expect(
    acceptFleetOperation(
      options(
        async () => {
          calls++;
          return ready;
        },
        { timeoutMs: 0 },
      ),
    ),
  ).rejects.toThrow("expired");
  expect(calls).toBe(0);
});
