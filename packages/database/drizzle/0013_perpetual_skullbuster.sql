CREATE TABLE "ota_attempts" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL,
	"ordinal" integer DEFAULT 1 NOT NULL,
	"command_id" uuid NOT NULL,
	"fence" bigint NOT NULL,
	"purpose" text DEFAULT 'APPLY' NOT NULL,
	"previous_attempt_id" uuid,
	"started_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"result_deadline" timestamp with time zone,
	"delivery_status" text DEFAULT 'HELD' NOT NULL,
	"application_status" text,
	"evaluation_status" text DEFAULT 'PENDING' NOT NULL,
	CONSTRAINT "ota_attempt_fence_valid" CHECK ("ota_attempts"."fence" > 0),
	CONSTRAINT "ota_attempt_purpose_valid" CHECK ("ota_attempts"."purpose" IN ('APPLY','ROLLBACK')),
	CONSTRAINT "ota_attempt_times_valid" CHECK (("ota_attempts"."started_at" IS NULL AND "ota_attempts"."expires_at" IS NULL AND "ota_attempts"."result_deadline" IS NULL AND "ota_attempts"."delivery_status"='HELD') OR ("ota_attempts"."started_at" IS NOT NULL AND "ota_attempts"."expires_at"="ota_attempts"."started_at"+interval '300 seconds' AND "ota_attempts"."result_deadline"="ota_attempts"."started_at"+interval '600 seconds' AND "ota_attempts"."delivery_status"<>'HELD'))
);
--> statement-breakpoint
CREATE TABLE "ota_deployments" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"idempotency_scope" text NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"request" jsonb NOT NULL,
	"release_id" uuid NOT NULL,
	"release_snapshot" jsonb NOT NULL,
	"policy" jsonb NOT NULL,
	"status" text DEFAULT 'ACCEPTED' NOT NULL,
	"target_count" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ota_deployment_count_valid" CHECK ("ota_deployments"."target_count" BETWEEN 1 AND 100),
	CONSTRAINT "ota_deployment_scope_valid" CHECK ("ota_deployments"."idempotency_scope" = 'anonymous'),
	CONSTRAINT "ota_deployment_status_valid" CHECK ("ota_deployments"."status" IN ('ACCEPTED','RUNNING','STOPPING','PAUSED','WAITING_FOR_HUMAN','COMPLETED','FAILED','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "ota_device_states" (
	"device_id" varchar(64) PRIMARY KEY NOT NULL,
	"snapshot" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"highest_fence" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ota_device_fence_valid" CHECK ("ota_device_states"."highest_fence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ota_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ota_outbox" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" text,
	"status" text DEFAULT 'HELD' NOT NULL,
	"expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ota_outbox_held_valid" CHECK (("ota_outbox"."status"='HELD' AND "ota_outbox"."payload" IS NULL AND "ota_outbox"."expires_at" IS NULL AND "ota_outbox"."next_attempt_at" IS NULL AND "ota_outbox"."attempts"=0) OR ("ota_outbox"."status"<>'HELD' AND "ota_outbox"."payload" IS NOT NULL AND "ota_outbox"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ota_reservations" (
	"device_id" varchar(64) PRIMARY KEY NOT NULL,
	"target_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ota_stages" (
	"stage_id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" text NOT NULL,
	"device_ids" jsonb NOT NULL,
	CONSTRAINT "ota_stage_position_valid" CHECK ("ota_stages"."position" BETWEEN 0 AND 9),
	CONSTRAINT "ota_stage_status_valid" CHECK ("ota_stages"."status" IN ('PENDING','RUNNING','AWAITING_APPROVAL','PASSED','STOPPING','PAUSED','FAILED'))
);
--> statement-breakpoint
CREATE TABLE "ota_targets" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_target_valid";--> statement-breakpoint
ALTER TABLE "ota_attempts" ADD CONSTRAINT "ota_attempts_target_id_ota_targets_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."ota_targets"("target_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_deployments" ADD CONSTRAINT "ota_deployments_release_id_releases_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("release_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_device_states" ADD CONSTRAINT "ota_device_states_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_events" ADD CONSTRAINT "ota_events_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ota_attempt_command_unique" ON "ota_attempts" USING btree ("command_id");--> statement-breakpoint
ALTER TABLE "ota_outbox" ADD CONSTRAINT "ota_outbox_command_id_ota_attempts_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."ota_attempts"("command_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_reservations" ADD CONSTRAINT "ota_reservations_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_reservations" ADD CONSTRAINT "ota_reservations_target_id_ota_targets_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."ota_targets"("target_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_stages" ADD CONSTRAINT "ota_stages_deployment_id_ota_deployments_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."ota_deployments"("deployment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_deployment_id_ota_deployments_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."ota_deployments"("deployment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_stage_id_ota_stages_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."ota_stages"("stage_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ota_attempt_ordinal_unique" ON "ota_attempts" USING btree ("target_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_deployment_key_unique" ON "ota_deployments" USING btree ("idempotency_scope","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_event_sequence_unique" ON "ota_events" USING btree ("attempt_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_stage_position_unique" ON "ota_stages" USING btree ("deployment_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_target_device_unique" ON "ota_targets" USING btree ("deployment_id","device_id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_valid" CHECK ("audit_logs"."target_kind" IN ('group','device','command','operation','alert','release','deployment'));
--> statement-breakpoint
-- 受付snapshotは進行状態と分離し、後続workerからも書き換えない。
CREATE FUNCTION protect_ota_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'OTA snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_deployment_snapshot BEFORE UPDATE ON ota_deployments FOR EACH ROW EXECUTE FUNCTION protect_ota_snapshot();
--> statement-breakpoint
CREATE TRIGGER ota_stage_snapshot BEFORE UPDATE ON ota_stages FOR EACH ROW EXECUTE FUNCTION protect_ota_snapshot();
--> statement-breakpoint
CREATE TRIGGER ota_target_snapshot BEFORE UPDATE ON ota_targets FOR EACH ROW EXECUTE FUNCTION protect_ota_snapshot();
--> statement-breakpoint
CREATE FUNCTION protect_ota_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.attempt_id,NEW.target_id,NEW.ordinal,NEW.command_id,NEW.fence,NEW.purpose,NEW.previous_attempt_id)
    IS DISTINCT FROM ROW(OLD.attempt_id,OLD.target_id,OLD.ordinal,OLD.command_id,OLD.fence,OLD.purpose,OLD.previous_attempt_id)
    OR (OLD.started_at IS NOT NULL AND ROW(NEW.started_at,NEW.expires_at,NEW.result_deadline)
      IS DISTINCT FROM ROW(OLD.started_at,OLD.expires_at,OLD.result_deadline)) THEN
    RAISE EXCEPTION 'OTA attempt identity and issued deadlines are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_attempt_identity BEFORE UPDATE ON ota_attempts FOR EACH ROW EXECUTE FUNCTION protect_ota_attempt();
--> statement-breakpoint
CREATE FUNCTION protect_ota_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.command_id,NEW.topic) IS DISTINCT FROM ROW(OLD.command_id,OLD.topic)
    OR (OLD.payload IS NOT NULL AND ROW(NEW.payload,NEW.expires_at) IS DISTINCT FROM ROW(OLD.payload,OLD.expires_at)) THEN
    RAISE EXCEPTION 'issued OTA payload is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_outbox_identity BEFORE UPDATE ON ota_outbox FOR EACH ROW EXECUTE FUNCTION protect_ota_outbox();
--> statement-breakpoint
CREATE FUNCTION protect_ota_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.highest_fence < OLD.highest_fence THEN
    RAISE EXCEPTION 'OTA fence cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_fence_monotonic BEFORE UPDATE ON ota_device_states FOR EACH ROW EXECUTE FUNCTION protect_ota_fence();
