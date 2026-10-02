import { telemetry, type Database } from "@drone-fleet/database";
import { and, gte, inArray, lt } from "drizzle-orm";

import type { LoadReportRepository } from "./types.js";

export function createLoadReportRepository(
  database: Database,
): LoadReportRepository {
  return {
    async findTelemetry({ deviceIds, startedAt, endedAt }) {
      if (deviceIds.length === 0) return [];
      return database
        .select({ deviceId: telemetry.deviceId, sequence: telemetry.sequence })
        .from(telemetry)
        .where(
          and(
            inArray(telemetry.deviceId, deviceIds),
            gte(telemetry.deviceTimestamp, startedAt),
            lt(telemetry.deviceTimestamp, endedAt),
          ),
        )
        .orderBy(telemetry.deviceId, telemetry.sequence);
    },
  };
}
