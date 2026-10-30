import { afterEach, expect, it, vi } from "vitest";
import {
  fetchDeployment,
  fetchDeployments,
  fetchReleases,
  sendIntent,
  type Pending,
} from "../src/ota-api.js";
import { otaFixture } from "./ota-fixtures.js";
afterEach(() => vi.unstubAllGlobals());
it("passes the stable two-field cursor and abort signal to the list API", async () => {
  const f = otaFixture(),
    controller = new AbortController();
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          items: [],
          limit: 20,
          nextBefore: null,
          nextBeforeId: null,
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await fetchDeployments(
    "http://api.test",
    f.at(),
    f.data.deploymentId,
    controller.signal,
  );
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining(`beforeId=${f.data.deploymentId}`),
    expect.objectContaining({
      signal: controller.signal,
      method: "GET",
      cache: "no-store",
    }),
  );
});
it("rejects an inconsistent release identity and never treats registration as present-day verification", async () => {
  const f = otaFixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ ...f.release, digest: "c".repeat(64) }],
            limit: 100,
          }),
        ),
    ),
  );
  await expect(fetchReleases("http://api.test")).rejects.toThrow();
});
it("rejects a detail response for a different deployment", async () => {
  const f = otaFixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(f.data))),
  );
  await expect(
    fetchDeployment("http://api.test", crypto.randomUUID()),
  ).rejects.toThrow("deployment ID mismatch");
});
it("does not resolve an ambiguous request with another target's recovery response", async () => {
  const f = otaFixture();
  const pending: Pending = {
    version: 1,
    key: crypto.randomUUID(),
    intent: {
      action: "RETRY",
      deploymentId: f.data.deploymentId,
      targetId: f.data.targets[0]!.targetId,
      body: { reason: "CHECKED" },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            deploymentId: f.data.deploymentId,
            targetId: crypto.randomUUID(),
            interventionId: crypto.randomUUID(),
            recoveryId: crypto.randomUUID(),
            kind: "RETRY",
            status: "WAITING",
          }),
          { status: 202 },
        ),
    ),
  );
  await expect(sendIntent("http://api.test", pending)).rejects.toThrow(
    "recovery acceptance mismatch",
  );
});
