DROP INDEX "audit_logs_occurred_idx";--> statement-breakpoint
CREATE INDEX "audit_logs_actor_time_idx" ON "audit_logs" USING btree ("actor_kind","actor_id","occurred_at" DESC NULLS LAST,"event_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_action_time_idx" ON "audit_logs" USING btree ("action","occurred_at" DESC NULLS LAST,"event_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_result_time_idx" ON "audit_logs" USING btree ("result","occurred_at" DESC NULLS LAST,"event_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_occurred_idx" ON "audit_logs" USING btree ("occurred_at" DESC NULLS LAST,"event_id" DESC NULLS LAST);