CREATE TABLE "command_outbox" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "command_outbox_state" CHECK ("command_outbox"."state" IN ('PENDING', 'WAITING_ACK', 'ACKNOWLEDGED', 'FAILED', 'EXPIRED', 'TIMED_OUT')),
	CONSTRAINT "command_outbox_counts" CHECK ("command_outbox"."attempts" >= 0 AND "command_outbox"."failures" >= 0 AND "command_outbox"."failures" <= "command_outbox"."attempts")
);
--> statement-breakpoint
ALTER TABLE "command_outbox" ADD CONSTRAINT "command_outbox_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "command_outbox_due_idx" ON "command_outbox" USING btree ("state","next_attempt_at");