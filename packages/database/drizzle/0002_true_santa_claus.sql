ALTER TABLE "telemetry" ADD COLUMN "identity_owner" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry" ADD COLUMN "source_payload" jsonb;--> statement-breakpoint
-- 既存の重複履歴を残し、最初の行だけを一意キーの代表にする。
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY device_id, session_id, sequence ORDER BY id
  ) AS position
  FROM telemetry WHERE session_id IS NOT NULL
)
UPDATE telemetry SET identity_owner = false
FROM ranked WHERE telemetry.id = ranked.id AND ranked.position > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_identity_idx" ON "telemetry" USING btree ("device_id","session_id","sequence") WHERE "telemetry"."session_id" is not null and "telemetry"."identity_owner";
