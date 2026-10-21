import { appendAudit, releases, type Database } from "@drone-fleet/database";
import { canonical, ReleaseError, type Envelope } from "@drone-fleet/releases";
import { desc, eq } from "drizzle-orm";

export function createReleaseRepository(db: Database) {
  return {
    async register(envelope: Envelope) {
      return db.transaction(async (tx) => {
        const m = envelope.manifest;
        const [inserted] = await tx
          .insert(releases)
          .values({
            releaseId: m.releaseId,
            application: m.application,
            version: m.version,
            platform: m.platform,
            digest: m.digest,
            envelope,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(releases)
            .where(eq(releases.releaseId, m.releaseId));
          if (existing && canonical(existing.envelope) === canonical(envelope))
            return { release: existing, created: false };
          throw new ReleaseError("RELEASE_CONFLICT", 409);
        }
        await appendAudit(tx, {
          action: "release.registered",
          targetKind: "release",
          targetId: m.releaseId,
          metadata: { afterStatus: "VERIFIED" },
        });
        return { release: inserted, created: true };
      });
    },
    async find(id: string) {
      const [row] = await db
        .select()
        .from(releases)
        .where(eq(releases.releaseId, id));
      if (!row) throw new ReleaseError("RELEASE_NOT_FOUND", 404);
      return row;
    },
    list: () =>
      db
        .select()
        .from(releases)
        .orderBy(desc(releases.verifiedAt), desc(releases.releaseId))
        .limit(100),
  };
}
export type ReleaseRepository = ReturnType<typeof createReleaseRepository>;
