CREATE TABLE "bridge_action_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"command_id" uuid NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"message" jsonb NOT NULL,
	"disposition" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ros_command_targets" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"configuration_id" varchar(64) NOT NULL,
	"report_event_id" uuid NOT NULL,
	"result_deadline" timestamp with time zone NOT NULL,
	"goal_id" uuid,
	"accepted_at" timestamp with time zone,
	"terminal_event_id" uuid,
	"stop_confirmed" boolean DEFAULT false NOT NULL,
	"not_started" boolean DEFAULT false NOT NULL,
	"conflicted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ros_command_targets_goal_id_unique" UNIQUE("goal_id"),
	CONSTRAINT "ros_target_release_valid" CHECK (NOT ("ros_command_targets"."stop_confirmed" AND "ros_command_targets"."not_started") AND
      (NOT "ros_command_targets"."conflicted" OR (NOT "ros_command_targets"."stop_confirmed" AND NOT "ros_command_targets"."not_started")))
);
--> statement-breakpoint
ALTER TABLE "commands" DROP CONSTRAINT "commands_execution_status_valid";--> statement-breakpoint
ALTER TABLE "commands" DROP CONSTRAINT "commands_execution_times_required";--> statement-breakpoint
ALTER TABLE "ros_command_targets" ADD CONSTRAINT "ros_command_targets_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ros_command_targets" ADD CONSTRAINT "ros_command_targets_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ros_command_targets" ADD CONSTRAINT "ros_command_targets_configuration_id_bridge_configurations_configuration_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."bridge_configurations"("configuration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ros_command_targets" ADD CONSTRAINT "ros_command_targets_report_event_id_bridge_reports_event_id_fk" FOREIGN KEY ("report_event_id") REFERENCES "public"."bridge_reports"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_action_events_command_idx" ON "bridge_action_events" USING btree ("command_id","received_at");--> statement-breakpoint
CREATE INDEX "ros_command_targets_device_open_idx" ON "ros_command_targets" USING btree ("device_id","stop_confirmed");--> statement-breakpoint
CREATE TRIGGER bridge_action_events_immutable BEFORE UPDATE ON bridge_action_events FOR EACH ROW EXECUTE FUNCTION bridge_immutable_document();
--> statement-breakpoint
CREATE FUNCTION ros_immutable_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.command_id,NEW.device_id,NEW.configuration_id,NEW.report_event_id,NEW.result_deadline)
   IS DISTINCT FROM (OLD.command_id,OLD.device_id,OLD.configuration_id,OLD.report_event_id,OLD.result_deadline)
   OR (OLD.goal_id IS NOT NULL AND NEW.goal_id IS DISTINCT FROM OLD.goal_id)
   OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
   OR (OLD.terminal_event_id IS NOT NULL AND NEW.terminal_event_id IS DISTINCT FROM OLD.terminal_event_id)
 THEN RAISE EXCEPTION 'ROS command identity is immutable'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ros_target_immutable BEFORE UPDATE ON ros_command_targets FOR EACH ROW EXECUTE FUNCTION ros_immutable_target();
--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_execution_status_valid" CHECK ("commands"."execution_status" IN ('NOT_REPORTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'REJECTED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_execution_times_required" CHECK ("commands"."execution_status" = 'NOT_REPORTED'
        OR ("commands"."execution_status" IN ('REJECTED','UNCERTAIN')
          AND "commands"."execution_started_at" IS NULL AND "commands"."execution_started_received_at" IS NULL
          AND "commands"."expires_at" IS NOT NULL AND "commands"."execution_result_at" IS NOT NULL
          AND "commands"."execution_result_received_at" IS NOT NULL AND "commands"."execution_result_at" >= "commands"."created_at")
        OR ("commands"."execution_status" <> 'REJECTED' AND "commands"."execution_started_at" IS NOT NULL
          AND "commands"."execution_started_received_at" IS NOT NULL AND "commands"."expires_at" IS NOT NULL
          AND "commands"."execution_started_at" >= "commands"."created_at" AND "commands"."execution_started_at" < "commands"."expires_at"
          AND ("commands"."execution_status" = 'RUNNING' OR ("commands"."execution_result_at" IS NOT NULL
            AND "commands"."execution_result_received_at" IS NOT NULL AND "commands"."execution_result_at" >= "commands"."execution_started_at"))));
