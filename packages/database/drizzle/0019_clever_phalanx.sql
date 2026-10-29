CREATE TABLE "ota_recoveries" (
	"recovery_id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"previous_attempt_id" uuid NOT NULL,
	"root_attempt_id" uuid NOT NULL,
	"attempt_id" uuid,
	"kind" text NOT NULL,
	"key" varchar(128) NOT NULL,
	"request_hash" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"required_action" text,
	"release_snapshot" jsonb,
	"previous_boot_id" uuid,
	"detected_at" timestamp with time zone NOT NULL,
	"budget_deadline" timestamp with time zone NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"approved_at" timestamp with time zone NOT NULL,
	"bytes_at_approval" bigint,
	"downloaded_bytes" bigint,
	"cost" jsonb,
	"evidence" jsonb NOT NULL,
	"response" jsonb NOT NULL,
	CONSTRAINT "ota_recoveries_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "ota_recovery_budget_valid" CHECK ("ota_recoveries"."budget_deadline"="ota_recoveries"."detected_at"+interval '900 seconds' AND "ota_recoveries"."kind" IN ('RETRY','ROLLBACK'))
);
--> statement-breakpoint
ALTER TABLE "ota_recoveries" ADD CONSTRAINT "ota_recoveries_deployment_id_ota_deployments_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."ota_deployments"("deployment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_recoveries" ADD CONSTRAINT "ota_recoveries_target_id_ota_targets_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."ota_targets"("target_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_recoveries" ADD CONSTRAINT "ota_recoveries_previous_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("previous_attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_recoveries" ADD CONSTRAINT "ota_recoveries_root_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("root_attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_recoveries" ADD CONSTRAINT "ota_recoveries_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ota_recovery_key_unique" ON "ota_recoveries" USING btree ("deployment_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_recovery_active_unique" ON "ota_recoveries" USING btree ("target_id") WHERE "ota_recoveries"."status" IN ('WAITING','RUNNING');--> statement-breakpoint
CREATE UNIQUE INDEX "ota_recovery_attempt_limit" ON "ota_recoveries" USING btree ("target_id","kind") WHERE "ota_recoveries"."attempt_id" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION protect_ota_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','failure_reason','required_action','started_at','finished_at','downloaded_bytes','evidence']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','failure_reason','required_action','started_at','finished_at','downloaded_bytes','evidence'])
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
    OR (OLD.downloaded_bytes IS NOT NULL AND (NEW.downloaded_bytes IS NULL OR NEW.downloaded_bytes < OLD.downloaded_bytes))
    OR NOT (NEW.evidence @> OLD.evidence) THEN
    RAISE EXCEPTION 'OTA recovery identity and budgets are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_recovery_immutable BEFORE UPDATE ON ota_recoveries FOR EACH ROW EXECUTE FUNCTION protect_ota_recovery();
