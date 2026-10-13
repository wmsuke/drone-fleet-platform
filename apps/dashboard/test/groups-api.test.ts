import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { fetchGroup, fetchGroups, mutateGroup } from "../src/groups-api.js";
afterEach(() => vi.unstubAllGlobals());
it("rejects invalid group counts and malformed responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            groupId: "g",
            name: "隊",
            description: null,
            revision: 1,
            createdAt: "2026-10-13T00:00:00Z",
            updatedAt: "2026-10-13T00:00:00Z",
            deviceCount: 2,
            deviceIds: [],
          }),
        ),
    ),
  );
  await expect(fetchGroup("http://api.test", "g")).rejects.toThrow(TypeError);
  await expect(fetchGroups("http://api.test")).rejects.toThrow(TypeError);
});
it("passes abort signals and encodes resource IDs", async () => {
  const mock = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", mock);
  const controller = new AbortController();
  await fetchGroups("http://api.test", controller.signal);
  expect(mock).toHaveBeenCalledWith(
    "http://api.test/groups",
    expect.objectContaining({ signal: controller.signal }),
  );
  mock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await mutateGroup("http://api.test", {
    type: "remove",
    groupId: "a/b",
    deviceId: "x/y",
  });
  expect(mock).toHaveBeenLastCalledWith(
    "http://api.test/groups/a%2Fb/devices/x%2Fy",
    expect.objectContaining({ method: "DELETE" }),
  );
});
it("preserves HTTP errors for conflict handling", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 409 })),
  );
  await expect(
    mutateGroup("http://api.test", {
      type: "add",
      groupId: "g",
      deviceId: "d",
    }),
  ).rejects.toBeInstanceOf(ApiError);
});
