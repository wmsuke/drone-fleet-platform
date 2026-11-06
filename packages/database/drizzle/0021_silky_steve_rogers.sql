CREATE TABLE "observation_conflicts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"message" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_identities" (
	"device_id" varchar(64) NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"message" jsonb NOT NULL,
	CONSTRAINT "observation_identities_device_id_session_id_sequence_pk" PRIMARY KEY("device_id","session_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "ros_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"device_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"is_retained" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "ros_observations_sequence_valid" CHECK ("ros_observations"."sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "observation_identities" ADD CONSTRAINT "observation_identities_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ros_observations" ADD CONSTRAINT "ros_observations_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ros_observations_identity_idx" ON "ros_observations" USING btree ("device_id","session_id","sequence");--> statement-breakpoint
CREATE INDEX "ros_observations_device_time_idx" ON "ros_observations" USING btree ("device_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
INSERT INTO observation_identities (device_id, session_id, sequence, message)
SELECT device_id, session_id, sequence,
  jsonb_build_object('schemaVersion', 2, 'deviceId', device_id, 'sessionId', session_id,
    'sequence', sequence, 'timestamp', coalesce(source_payload->>'timestamp', to_char(device_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'payload', CASE WHEN source_payload IS NOT NULL THEN source_payload - 'timestamp'
      ELSE jsonb_build_object('battery', battery, 'latitude', latitude, 'longitude', longitude, 'altitude', altitude, 'temperature', temperature, 'status', flight_status) END)
FROM telemetry WHERE session_id IS NOT NULL AND identity_owner;
