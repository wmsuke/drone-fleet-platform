CREATE TABLE "bridge_health_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"message" jsonb NOT NULL,
	"disposition" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bridge_health_device_idx" ON "bridge_health_events" USING btree ("device_id","received_at");
--> statement-breakpoint
CREATE TRIGGER bridge_health_events_immutable BEFORE UPDATE ON bridge_health_events FOR EACH ROW EXECUTE FUNCTION bridge_immutable_document();
