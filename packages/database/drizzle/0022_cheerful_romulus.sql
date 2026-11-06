CREATE TABLE "bridge_command_configurations" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"goal_id" uuid NOT NULL,
	"configuration_id" varchar(64) NOT NULL,
	"report_event_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stop_confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "bridge_command_configurations_goal_id_unique" UNIQUE("goal_id")
);
--> statement-breakpoint
CREATE TABLE "bridge_configuration_heads" (
	"device_id" varchar(64) PRIMARY KEY NOT NULL,
	"journal_id" uuid,
	"report_event_id" uuid,
	"configuration_id" varchar(64),
	"configuration_revision" bigint DEFAULT 0 NOT NULL,
	"report_sequence" bigint DEFAULT 0 NOT NULL,
	"reported_at" timestamp with time zone,
	"desired_id" varchar(64),
	"desired_revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_configurations" (
	"configuration_id" varchar(64) PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_conflicts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_definitions" (
	"key" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_reports" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"message" jsonb NOT NULL,
	"disposition" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bridge_reports_disposition_valid" CHECK ("bridge_reports"."disposition" IN ('CURRENT','STALE','CONFLICT','ACTIVE_EXECUTION','CLOCK_INVALID','JOURNAL_MISMATCH'))
);
--> statement-breakpoint
ALTER TABLE "bridge_command_configurations" ADD CONSTRAINT "bridge_command_configurations_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_command_configurations" ADD CONSTRAINT "bridge_command_configurations_configuration_id_bridge_configurations_configuration_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."bridge_configurations"("configuration_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_command_configurations" ADD CONSTRAINT "bridge_command_configurations_report_event_id_bridge_reports_event_id_fk" FOREIGN KEY ("report_event_id") REFERENCES "public"."bridge_reports"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_configuration_heads" ADD CONSTRAINT "bridge_configuration_heads_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_configuration_heads" ADD CONSTRAINT "bridge_configuration_heads_report_event_id_bridge_reports_event_id_fk" FOREIGN KEY ("report_event_id") REFERENCES "public"."bridge_reports"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_configuration_heads" ADD CONSTRAINT "bridge_configuration_heads_configuration_id_bridge_configurations_configuration_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."bridge_configurations"("configuration_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_configurations" ADD CONSTRAINT "bridge_configurations_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_reports" ADD CONSTRAINT "bridge_reports_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_reports_device_time_idx" ON "bridge_reports" USING btree ("device_id","received_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE FUNCTION bridge_immutable_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Bridge configuration evidence is immutable'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER bridge_configurations_immutable BEFORE UPDATE ON bridge_configurations FOR EACH ROW EXECUTE FUNCTION bridge_immutable_document();
--> statement-breakpoint
CREATE TRIGGER bridge_definitions_immutable BEFORE UPDATE ON bridge_definitions FOR EACH ROW EXECUTE FUNCTION bridge_immutable_document();
--> statement-breakpoint
CREATE TRIGGER bridge_reports_immutable BEFORE UPDATE ON bridge_reports FOR EACH ROW EXECUTE FUNCTION bridge_immutable_document();
--> statement-breakpoint
CREATE FUNCTION bridge_immutable_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.command_id, NEW.goal_id, NEW.configuration_id, NEW.report_event_id, NEW.started_at)
    IS DISTINCT FROM (OLD.command_id, OLD.goal_id, OLD.configuration_id, OLD.report_event_id, OLD.started_at)
 THEN RAISE EXCEPTION 'Bridge execution configuration reference is immutable'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bridge_binding_immutable BEFORE UPDATE ON bridge_command_configurations FOR EACH ROW EXECUTE FUNCTION bridge_immutable_binding();
