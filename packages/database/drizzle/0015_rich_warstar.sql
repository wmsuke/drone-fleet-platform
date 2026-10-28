ALTER TABLE "ota_rejections" ALTER COLUMN "attempt_id" DROP NOT NULL;
--> statement-breakpoint
CREATE FUNCTION reject_ota_history_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OTA history is immutable' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_event_immutable BEFORE UPDATE ON ota_events FOR EACH ROW EXECUTE FUNCTION reject_ota_history_update();
--> statement-breakpoint
CREATE TRIGGER ota_evaluation_immutable BEFORE UPDATE ON ota_evaluations FOR EACH ROW EXECUTE FUNCTION reject_ota_history_update();
--> statement-breakpoint
CREATE TRIGGER ota_inventory_immutable BEFORE UPDATE ON ota_inventories FOR EACH ROW EXECUTE FUNCTION reject_ota_history_update();
--> statement-breakpoint
CREATE TRIGGER ota_rejection_immutable BEFORE UPDATE ON ota_rejections FOR EACH ROW EXECUTE FUNCTION reject_ota_history_update();
--> statement-breakpoint
CREATE FUNCTION protect_ota_query() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['attempts','next_attempt_at','consumed_event_id'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['attempts','next_attempt_at','consumed_event_id'])
    OR NEW.attempts < OLD.attempts OR NEW.attempts > 5
    OR (OLD.consumed_event_id IS NOT NULL AND NEW.consumed_event_id IS DISTINCT FROM OLD.consumed_event_id) THEN
    RAISE EXCEPTION 'issued OTA query is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_query_identity BEFORE UPDATE ON ota_queries FOR EACH ROW EXECUTE FUNCTION protect_ota_query();
