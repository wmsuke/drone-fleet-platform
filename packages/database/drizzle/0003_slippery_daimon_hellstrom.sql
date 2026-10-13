ALTER TYPE "public"."command_status" ADD VALUE 'EXPIRED';--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "expired_at" timestamp with time zone;