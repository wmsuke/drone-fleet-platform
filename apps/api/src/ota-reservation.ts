import { otaReservations, type Database } from "@drone-fleet/database";
import { inArray } from "drizzle-orm";

export class OtaReservationError extends Error {
  constructor() {
    super("DEVICE_RESERVED_FOR_OTA");
  }
}
// 呼出側は同じtransactionで対象device rowをASCII順にlockしてから確認する。
export async function assertNotOtaReserved(
  tx: Pick<Database, "select">,
  ids: string[],
) {
  if (
    (
      await tx
        .select()
        .from(otaReservations)
        .where(inArray(otaReservations.deviceId, ids))
        .limit(1)
    ).length
  )
    throw new OtaReservationError();
}
