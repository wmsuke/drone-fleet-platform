CREATE TYPE "public"."command_status" AS ENUM('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'TIMED_OUT');--> statement-breakpoint
CREATE TYPE "public"."command_type" AS ENUM('RETURN_HOME', 'REBOOT');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('ONLINE', 'OFFLINE');--> statement-breakpoint
CREATE TYPE "public"."flight_status" AS ENUM('IDLE', 'FLYING', 'RETURNING_HOME');--> statement-breakpoint
CREATE TABLE "commands" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"type" "command_type" NOT NULL,
	"status" "command_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"acknowledgement_received_at" timestamp with time zone,
	"timed_out_at" timestamp with time zone,
	CONSTRAINT "commands_acknowledged_at_required" CHECK ("commands"."status" <> 'ACKNOWLEDGED' OR "commands"."acknowledgement_received_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"device_id" varchar(64) NOT NULL,
	"model" varchar(100),
	"software_version" varchar(100),
	"connection_status" "connection_status" DEFAULT 'OFFLINE' NOT NULL,
	"last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_device_id_pk" PRIMARY KEY("device_id")
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"sequence" integer NOT NULL,
	"device_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"battery" real NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"altitude" double precision NOT NULL,
	"temperature" double precision NOT NULL,
	"flight_status" "flight_status" NOT NULL,
	CONSTRAINT "telemetry_sequence_non_negative" CHECK ("telemetry"."sequence" >= 0),
	CONSTRAINT "telemetry_battery_range" CHECK ("telemetry"."battery" >= 0 AND "telemetry"."battery" <= 100),
	CONSTRAINT "telemetry_latitude_range" CHECK ("telemetry"."latitude" >= -90 AND "telemetry"."latitude" <= 90),
	CONSTRAINT "telemetry_longitude_range" CHECK ("telemetry"."longitude" >= -180 AND "telemetry"."longitude" <= 180),
	CONSTRAINT "telemetry_altitude_finite_non_negative" CHECK ("telemetry"."altitude" >= 0 AND "telemetry"."altitude" < 'Infinity'::double precision),
	CONSTRAINT "telemetry_temperature_finite" CHECK ("telemetry"."temperature" > '-Infinity'::double precision AND "telemetry"."temperature" < 'Infinity'::double precision)
);
--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commands_device_created_at_idx" ON "commands" USING btree ("device_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "commands_status_created_at_idx" ON "commands" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_device_sequence_unique" ON "telemetry" USING btree ("device_id","sequence");--> statement-breakpoint
CREATE INDEX "telemetry_device_received_at_idx" ON "telemetry" USING btree ("device_id","received_at" DESC NULLS LAST);