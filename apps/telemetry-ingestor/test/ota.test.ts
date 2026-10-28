import { expect, it, vi } from "vitest";
import { ingestOta } from "../src/ota.js";
import { otaFixture } from "../../../packages/database/test/ota-fixture.js";
import { serializeOtaEvent } from "@drone-fleet/protocol";
import { createHash } from "node:crypto";
function setup() {
  const f = otaFixture(),
    event = f.events[0]!,
    now = f.at(0);
  const receipt = {
    schemaVersion: 1 as const,
    deviceId: event.deviceId,
    deploymentId: event.deploymentId,
    stageId: event.stageId,
    targetId: event.targetId,
    attemptId: event.attemptId,
    fence: event.fence,
    release: event.release,
    eventId: event.eventId,
    payloadHash: createHash("sha256")
      .update(serializeOtaEvent(event))
      .digest("hex"),
    status: "STORED" as const,
    receivedAt: now.toISOString(),
    storedAt: now.toISOString(),
  };
  const repository = {
      ingest: vi.fn(async () => receipt),
      inventory: vi.fn(async () => null),
    },
    publish = vi.fn<(topic: string, payload: string) => Promise<void>>(
      async () => {},
    ),
    logger = { error: vi.fn(), warn: vi.fn() };
  const topic = `fleet/v1/devices/${event.deviceId}/ota-events`,
    payload = Buffer.from(JSON.stringify(event));
  return {
    f,
    event,
    now,
    receipt,
    repository,
    publish,
    logger,
    topic,
    payload,
  };
}
it("publishes only the committed repository result and retries the same receipt after PUBACK loss", async () => {
  const s = setup();
  s.publish.mockImplementation(async () => {
    expect(s.repository.ingest).toHaveBeenCalled();
  });
  s.publish.mockRejectedValueOnce(new Error("PUBACK lost"));
  for (let i = 0; i < 2; i++)
    await ingestOta(
      s.topic,
      s.payload,
      { qos: 1, retain: false },
      s.now,
      s.repository,
      s.publish,
      s.logger,
    );
  expect(s.publish).toHaveBeenCalledTimes(2);
  expect(s.publish.mock.calls[0]).toEqual(s.publish.mock.calls[1]);
});
it("does not publish a receipt when storage fails", async () => {
  const s = setup();
  s.repository.ingest.mockRejectedValue(new Error("database failure"));
  await ingestOta(
    s.topic,
    s.payload,
    { qos: 1, retain: false },
    s.now,
    s.repository,
    s.publish,
    s.logger,
  );
  expect(s.publish).not.toHaveBeenCalled();
  expect(s.logger.error).toHaveBeenCalledOnce();
});
it.each([
  { qos: 0, retain: false },
  { qos: 1, retain: true },
])("rejects invalid MQTT metadata %j", async (packet) => {
  const s = setup();
  await ingestOta(
    s.topic,
    s.payload,
    packet,
    s.now,
    s.repository,
    s.publish,
    s.logger,
  );
  expect(s.repository.ingest).not.toHaveBeenCalled();
  expect(s.publish).not.toHaveBeenCalled();
});
it("rejects malformed/oversize messages without logging the input", async () => {
  const s = setup();
  for (const payload of [
    Buffer.from("secret-invalid-json"),
    Buffer.alloc(16385),
  ])
    await ingestOta(
      s.topic,
      payload,
      { qos: 1, retain: false },
      s.now,
      s.repository,
      s.publish,
      s.logger,
    );
  expect(JSON.stringify(s.logger.error.mock.calls)).not.toContain(
    "secret-invalid-json",
  );
  expect(s.repository.ingest).not.toHaveBeenCalled();
});
