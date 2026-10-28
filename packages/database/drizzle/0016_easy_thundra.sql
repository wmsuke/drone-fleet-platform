CREATE TABLE "ota_actions" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"key" varchar(128) NOT NULL,
	"request_hash" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ota_dispatches" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ota_rollouts" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_reason" text
);
--> statement-breakpoint
CREATE TABLE "ota_stops" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"result_deadline" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"confirmed_event_id" uuid,
	CONSTRAINT "ota_stops_attempt_id_unique" UNIQUE("attempt_id")
);
--> statement-breakpoint
ALTER TABLE "ota_actions" ADD CONSTRAINT "ota_actions_deployment_id_ota_deployments_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."ota_deployments"("deployment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_dispatches" ADD CONSTRAINT "ota_dispatches_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_rollouts" ADD CONSTRAINT "ota_rollouts_deployment_id_ota_deployments_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."ota_deployments"("deployment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_stops" ADD CONSTRAINT "ota_stops_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ota_action_key_unique" ON "ota_actions" USING btree ("deployment_id","key");
--> statement-breakpoint
CREATE TRIGGER ota_action_immutable BEFORE UPDATE ON ota_actions FOR EACH ROW EXECUTE FUNCTION reject_ota_history_update();
--> statement-breakpoint
CREATE FUNCTION protect_ota_stop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['attempts','next_attempt_at','confirmed_event_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['attempts','next_attempt_at','confirmed_event_id'])
    OR NEW.attempts < OLD.attempts OR NEW.attempts > 5
    OR (OLD.confirmed_event_id IS NOT NULL AND NEW.confirmed_event_id IS DISTINCT FROM OLD.confirmed_event_id) THEN
    RAISE EXCEPTION 'issued OTA stop is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_stop_identity BEFORE UPDATE ON ota_stops FOR EACH ROW EXECUTE FUNCTION protect_ota_stop();
