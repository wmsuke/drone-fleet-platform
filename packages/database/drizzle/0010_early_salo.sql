CREATE TABLE "audit_logs" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" varchar(128),
	"result" text NOT NULL,
	"request_id" uuid,
	"group_id" uuid,
	"operation_id" uuid,
	"command_id" uuid,
	"alert_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_logs_actor_valid" CHECK (("audit_logs"."actor_kind"='anonymous' AND "audit_logs"."actor_id" IS NULL) OR ("audit_logs"."actor_kind"='system' AND "audit_logs"."actor_id" IS NOT NULL AND "audit_logs"."actor_id" IN ('telemetry-ingestor','alert-evaluator','operation-evaluator'))),
	CONSTRAINT "audit_logs_result_valid" CHECK ("audit_logs"."result" IN ('SUCCEEDED','REJECTED','FAILED')),
	CONSTRAINT "audit_logs_target_valid" CHECK ("audit_logs"."target_kind" IN ('group','device','command','operation','alert')),
	CONSTRAINT "audit_logs_metadata_bounded" CHECK (jsonb_typeof("audit_logs"."metadata")='object' AND octet_length("audit_logs"."metadata"::text)<=8192),
	CONSTRAINT "audit_logs_version_valid" CHECK ("audit_logs"."schema_version"=1)
);
--> statement-breakpoint
CREATE TABLE "operation_audit_states" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"first_finished_at" timestamp with time zone,
	CONSTRAINT "operation_audit_states_status_valid" CHECK ("operation_audit_states"."status" IN ('ACCEPTED','IN_PROGRESS','COMPLETED','PARTIALLY_FAILED','FAILED'))
);
--> statement-breakpoint
ALTER TABLE "operation_audit_states" ADD CONSTRAINT "operation_audit_states_operation_id_fleet_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."fleet_operations"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_occurred_idx" ON "audit_logs" USING btree ("occurred_at" DESC NULLS LAST,"event_id");--> statement-breakpoint
CREATE INDEX "audit_logs_request_idx" ON "audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "audit_logs_operation_idx" ON "audit_logs" USING btree ("operation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_command_idx" ON "audit_logs" USING btree ("command_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_kind","target_id","occurred_at");
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;
