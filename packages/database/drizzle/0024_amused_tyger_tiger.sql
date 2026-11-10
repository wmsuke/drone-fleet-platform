CREATE TABLE "bridge_cancel_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"cancel_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"message" jsonb NOT NULL,
	"disposition" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ros_command_cancels" (
	"cancel_id" uuid PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"key" varchar(128) NOT NULL,
	"request" jsonb NOT NULL,
	"intervention_id" uuid NOT NULL,
	"actor_kind" text DEFAULT 'anonymous' NOT NULL,
	"actor_id" text,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"phase" text DEFAULT 'REQUESTED' NOT NULL,
	"assessment" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "ros_cancel_actor_valid" CHECK ("ros_command_cancels"."actor_kind"='anonymous' AND "ros_command_cancels"."actor_id" IS NULL),
	CONSTRAINT "ros_cancel_attempts_valid" CHECK ("ros_command_cancels"."attempts" BETWEEN 0 AND 3),
	CONSTRAINT "ros_cancel_phase_valid" CHECK ("ros_command_cancels"."phase" IN ('REQUESTED','RECEIVED','SEND_INTENT','ACCEPTED','REJECTED','UNCERTAIN')),
	CONSTRAINT "ros_cancel_assessment_valid" CHECK ("ros_command_cancels"."assessment" IN ('PENDING','REJECTED','UNCERTAIN','CANCELLED','COMPLETED','FAILED'))
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_valid";--> statement-breakpoint
ALTER TABLE "ros_command_cancels" ADD CONSTRAINT "ros_command_cancels_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_cancel_events_cancel_idx" ON "bridge_cancel_events" USING btree ("cancel_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ros_cancel_command_unique" ON "ros_command_cancels" USING btree ("command_id");--> statement-breakpoint
CREATE TRIGGER bridge_cancel_events_immutable BEFORE UPDATE ON bridge_cancel_events FOR EACH ROW EXECUTE FUNCTION bridge_immutable_document();
--> statement-breakpoint
CREATE FUNCTION ros_immutable_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.cancel_id,NEW.command_id,NEW.device_id,NEW.key,NEW.request,NEW.intervention_id,NEW.actor_kind,NEW.actor_id,NEW.request_id,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM (OLD.cancel_id,OLD.command_id,OLD.device_id,OLD.key,OLD.request,OLD.intervention_id,OLD.actor_kind,OLD.actor_id,OLD.request_id,OLD.created_at,OLD.expires_at)
 OR NEW.attempts < OLD.attempts
 THEN RAISE EXCEPTION 'ROS cancel identity is immutable'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ros_cancel_immutable BEFORE UPDATE ON ros_command_cancels FOR EACH ROW EXECUTE FUNCTION ros_immutable_cancel();
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_valid" CHECK (("audit_logs"."actor_kind"='anonymous' AND "audit_logs"."actor_id" IS NULL) OR ("audit_logs"."actor_kind"='system' AND "audit_logs"."actor_id" IS NOT NULL AND "audit_logs"."actor_id" IN ('telemetry-ingestor','alert-evaluator','operation-evaluator','ota-worker','cancel-worker')));
