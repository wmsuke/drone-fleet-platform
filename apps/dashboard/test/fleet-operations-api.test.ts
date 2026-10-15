import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import {
  fetchOperation,
  fetchOperations,
  sendOperation,
} from "../src/fleet-operations-api.js";
import {
  accepted,
  detail,
  groupId,
  operationId,
  json,
  list,
} from "./operation-fixtures.js";
afterEach(() => vi.unstubAllGlobals());
it("sends only group/type with a stable idempotency header and checks the receipt", async () => {
  const fetch = vi.fn(async () => json(accepted(), 202));
  vi.stubGlobal("fetch", fetch);
  const value = { groupId, type: "RETURN_HOME" as const, key: "saved-key" };
  expect(await sendOperation("http://api.test", value)).toEqual(accepted());
  await sendOperation("http://api.test", value);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]).toEqual([
    "http://api.test/fleet-operations",
    expect.objectContaining({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": "saved-key",
      },
      body: JSON.stringify({ groupId, type: "RETURN_HOME" }),
      signal: expect.any(AbortSignal),
    }),
  ]);
});
it("encodes query filters and forwards cancellation", async () => {
  const fetch = vi.fn(async () => json(detail()));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect(
    await fetchOperation(
      "http://api.test",
      operationId,
      { status: "UNRESPONSIVE", offset: 25 },
      signal,
    ),
  ).toEqual(detail());
  expect(fetch).toHaveBeenCalledWith(
    `http://api.test/fleet-operations/${operationId}?limit=25&offset=25&status=UNRESPONSIVE`,
    expect.objectContaining({ signal }),
  );
});
it("reads operation history including filters", async () => {
  const fetch = vi.fn(async () => json(list()));
  vi.stubGlobal("fetch", fetch);
  const v = await fetchOperations("http://api.test", {
    groupId,
    status: "IN_PROGRESS",
    offset: 20,
  });
  expect(v.total).toBe(1);
  expect(fetch).toHaveBeenCalledWith(
    `http://api.test/fleet-operations?limit=20&offset=20&groupId=${groupId}&status=IN_PROGRESS`,
    expect.anything(),
  );
});
it.each([400, 404, 409, 500])(
  "preserves HTTP %i errors rather than fabricating acceptance",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({}, status)),
    );
    await expect(
      sendOperation("", { groupId, type: "REBOOT", key: "key" }),
    ).rejects.toEqual(new ApiError(status));
    await expect(
      fetchOperation("", operationId, { offset: 0 }),
    ).rejects.toEqual(new ApiError(status));
    await expect(fetchOperations("")).rejects.toEqual(new ApiError(status));
  },
);
it.each([
  null,
  {},
  { ...detail(), status: "ACKNOWLEDGED" },
  { ...detail(), targetCount: 99 },
  { ...detail(), counts: { ...detail().counts, SUCCEEDED: -1 } },
  { ...detail(), evaluatedAt: "bad" },
  { ...detail(), updatedAt: null },
  {
    ...detail(),
    targets: {
      ...detail().targets,
      items: [{ ...detail().targets.items[0], status: "UNRECOGNIZED" }],
    },
  },
  {
    ...detail(),
    targets: {
      ...detail().targets,
      items: [
        { ...detail().targets.items[0], executionResultReceivedAt: "bad" },
      ],
    },
  },
  { ...detail(), operationId: groupId },
  { ...detail(), targets: { ...detail().targets, limit: 0 } },
])("rejects malformed aggregate response %j", async (v) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(v)),
  );
  await expect(fetchOperation("", operationId, { offset: 0 })).rejects.toThrow(
    TypeError,
  );
});
it.each([
  {},
  { ...accepted(), groupId: operationId },
  { ...accepted(), type: "REBOOT" },
  { ...accepted(), targetCount: 0 },
])("does not treat invalid receipts as accepted", async (v) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(v, 202)),
  );
  await expect(
    sendOperation("", { groupId, type: "RETURN_HOME", key: "key" }),
  ).rejects.toThrow(TypeError);
});
it("rejects malformed history, non-202 receipts and network failures", async () => {
  const mock = vi.fn(async () => json({ items: [], total: "0" }));
  vi.stubGlobal("fetch", mock);
  await expect(fetchOperations("")).rejects.toThrow(TypeError);
  mock.mockResolvedValue(json(accepted(), 200));
  await expect(
    sendOperation("", { groupId, type: "RETURN_HOME", key: "key" }),
  ).rejects.toThrow(TypeError);
  mock.mockRejectedValue(new Error("offline"));
  await expect(fetchOperations("")).rejects.toThrow("offline");
});
