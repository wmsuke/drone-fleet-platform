import { and, desc, eq, inArray } from "drizzle-orm";
import {
  rosCommandMessageSchema,
  supportsBridgeOperation,
} from "@drone-fleet/protocol";
import {
  bridgeConfigurationHeads,
  bridgeConfigurations,
  devices,
  rosObservations,
  rosCommandTargets,
  otaReservations,
} from "./schema.js";
import type { Database } from "./connection.js";
import { createBridgeHealthRepository } from "./bridge-health.js";
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export class RosCommandError extends Error {}

// 呼出側が同じtransactionでdevice rowをlockする。OTA/command共通の未停止予約。
export async function assertNoRosExecution(
  tx: Pick<Database, "select">,
  deviceIds: string[],
) {
  if (
    (
      await tx
        .select()
        .from(rosCommandTargets)
        .where(
          and(
            inArray(rosCommandTargets.deviceId, deviceIds),
            eq(rosCommandTargets.stopConfirmed, false),
            eq(rosCommandTargets.notStarted, false),
          ),
        )
        .limit(1)
    ).length
  )
    throw new RosCommandError("ROS_EXECUTION_UNRESOLVED");
}
export async function rosReadiness(
  tx: Pick<Database, "select">,
  deviceId: string,
  type: string,
  now: Date,
) {
  const [head] = await tx
    .select()
    .from(bridgeConfigurationHeads)
    .where(eq(bridgeConfigurationHeads.deviceId, deviceId));
  const [observation] = await tx
    .select()
    .from(rosObservations)
    .where(eq(rosObservations.deviceId, deviceId))
    .orderBy(desc(rosObservations.receivedAt), desc(rosObservations.id))
    .limit(1);
  if (!head && !observation) return null; // 従来simulatorはv2のまま。
  const [configuration] = head?.configurationId
    ? await tx
        .select()
        .from(bridgeConfigurations)
        .where(eq(bridgeConfigurations.configurationId, head.configurationId))
    : [];
  const [device] = await tx
    .select()
    .from(devices)
    .where(eq(devices.deviceId, deviceId));
  const fresh = (time: Date | null | undefined, limit: number) =>
    !!time && now >= time && now.getTime() - time.getTime() < limit;
  if (
    !configuration ||
    !head?.reportEventId ||
    !fresh(head.reportedAt, 15000) ||
    (head.desiredId !== null &&
      head.desiredId !== configuration.configurationId)
  )
    throw new RosCommandError("ROS_CONFIGURATION_UNAVAILABLE");
  if (!supportsBridgeOperation(configuration.snapshot, type))
    throw new RosCommandError("ROS_CAPABILITY_UNSUPPORTED");
  const snapshot = configuration.snapshot;
  if (
    snapshot.bridge.status !== "KNOWN" ||
    !["0.3.0", "0.4.0", "0.5.0"].includes(snapshot.bridge.version) ||
    snapshot.adapter.status !== "KNOWN" ||
    !["0.3.0", "0.4.0"].includes(snapshot.adapter.version) ||
    snapshot.profile.definition.version !== "1.1.0"
  )
    throw new RosCommandError("ROS_UPGRADE_REQUIRED");
  if (
    !device ||
    device.connectionStatus !== "ONLINE" ||
    !fresh(device.lastReceivedAt, 15000) ||
    !observation ||
    !fresh(observation.receivedAt, 3000) ||
    !["battery", "position", "flightStatus"].every(
      (k) => observation.payload.quality[k as "battery"].reason === "VALID",
    ) ||
    observation.payload.battery === null ||
    observation.payload.battery < 20 ||
    observation.payload.position?.kind !== "LOCAL" ||
    observation.payload.position.frameId !==
      configuration.snapshot.namespace.slice(1) + "/map" ||
    !["battery", "position", "flightStatus"].every((k) =>
      fresh(
        new Date(observation.payload.quality[k as "battery"].receivedAt ?? 0),
        3000,
      ),
    )
  )
    throw new RosCommandError("ROS_OBSERVATION_UNAVAILABLE");
  await assertNoRosExecution(tx, [deviceId]);
  if (
    snapshot.bridge.status === "KNOWN" &&
    snapshot.bridge.version === "0.5.0"
  ) {
    const health = await createBridgeHealthRepository(tx as Database).get(
      deviceId,
      now,
    );
    if (
      !health.ready ||
      health.latest?.message.serverInstanceId !== snapshot.serverInstanceId
    )
      throw new RosCommandError("ROS_HEALTH_UNAVAILABLE");
  }
  if (
    (
      await tx
        .select()
        .from(otaReservations)
        .where(eq(otaReservations.deviceId, deviceId))
        .limit(1)
    ).length
  )
    throw new RosCommandError("DEVICE_RESERVED_FOR_OTA");
  return { head, configuration };
}
export async function reserveRosCommand(
  tx: Transaction,
  command: {
    commandId: string;
    deviceId: string;
    type: string;
    createdAt: Date;
    expiresAt?: Date;
  },
) {
  const state = await rosReadiness(
    tx,
    command.deviceId,
    command.type,
    command.createdAt,
  );
  if (!state) return null;
  const resultDeadline = new Date(command.createdAt.getTime() + 120000);
  const payload = rosCommandMessageSchema.parse({
    schemaVersion: 3,
    targetKind: "ROS2",
    commandId: command.commandId,
    deviceId: command.deviceId,
    type: command.type,
    expectedConfigurationId: state.configuration.configurationId,
    timestamp: command.createdAt.toISOString(),
    expiresAt: command.expiresAt?.toISOString(),
    resultDeadline: resultDeadline.toISOString(),
  });
  await tx.insert(rosCommandTargets).values({
    commandId: command.commandId,
    deviceId: command.deviceId,
    configurationId: payload.expectedConfigurationId,
    reportEventId: state.head.reportEventId!,
    resultDeadline,
  });
  return payload;
}
