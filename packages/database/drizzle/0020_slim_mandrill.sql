CREATE TABLE "ota_interventions" (
	"intervention_id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"stage_id" uuid,
	"target_id" uuid,
	"attempt_id" uuid,
	"recovery_id" uuid,
	"action_id" uuid,
	"scope" jsonb NOT NULL,
	"actor_kind" text DEFAULT 'anonymous' NOT NULL,
	"actor_id" text,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"operation_result" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" bigint,
	"cost" jsonb,
	"audit_event_id" uuid NOT NULL,
	"completion_audit_event_id" uuid,
	"completion_reason" text,
	"resolution_recovery_id" uuid,
	"key" varchar(128),
	"request_hash" text,
	"completion_key" varchar(128),
	"completion_hash" text,
	CONSTRAINT "ota_interventions_recovery_id_unique" UNIQUE("recovery_id"),
	CONSTRAINT "ota_interventions_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "ota_interventions_audit_event_id_unique" UNIQUE("audit_event_id"),
	CONSTRAINT "ota_interventions_completion_audit_event_id_unique" UNIQUE("completion_audit_event_id"),
	CONSTRAINT "ota_intervention_actor_valid" CHECK ("ota_interventions"."actor_kind"='anonymous' AND "ota_interventions"."actor_id" IS NULL),
	CONSTRAINT "ota_intervention_kind_valid" CHECK (("ota_interventions"."kind"='STAGE_APPROVAL' AND "ota_interventions"."category"='REQUIRED_APPROVAL') OR ("ota_interventions"."kind" IN ('STOP','RESUME','RETRY_APPROVAL','ROLLBACK_APPROVAL','HUMAN_REVIEW') AND "ota_interventions"."category"='FAULT_RESPONSE')),
	CONSTRAINT "ota_intervention_times_valid" CHECK (("ota_interventions"."finished_at" IS NULL OR "ota_interventions"."finished_at">="ota_interventions"."started_at") AND ("ota_interventions"."duration_ms" IS NULL OR ("ota_interventions"."duration_ms">=0 AND "ota_interventions"."finished_at" IS NOT NULL AND "ota_interventions"."duration_ms"<=extract(epoch FROM ("ota_interventions"."finished_at"-"ota_interventions"."started_at"))*1000))),
	CONSTRAINT "ota_intervention_reason_valid" CHECK ("ota_interventions"."reason" ~ '^[A-Z][A-Z0-9_]{0,63}$' AND ("ota_interventions"."completion_reason" IS NULL OR "ota_interventions"."completion_reason" ~ '^[A-Z][A-Z0-9_]{0,63}$'))
);
--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_deployment_id_ota_deployments_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."ota_deployments"("deployment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_stage_id_ota_stages_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."ota_stages"("stage_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_target_id_ota_targets_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."ota_targets"("target_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_recovery_id_ota_recoveries_recovery_id_fk" FOREIGN KEY ("recovery_id") REFERENCES "public"."ota_recoveries"("recovery_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_action_id_ota_actions_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."ota_actions"("action_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_audit_event_id_audit_logs_event_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_logs"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_completion_audit_event_id_audit_logs_event_id_fk" FOREIGN KEY ("completion_audit_event_id") REFERENCES "public"."audit_logs"("event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_interventions" ADD CONSTRAINT "ota_interventions_resolution_recovery_id_ota_recoveries_recovery_id_fk" FOREIGN KEY ("resolution_recovery_id") REFERENCES "public"."ota_recoveries"("recovery_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ota_intervention_time_idx" ON "ota_interventions" USING btree ("deployment_id","started_at" DESC NULLS LAST,"intervention_id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ota_intervention_key_unique" ON "ota_interventions" USING btree ("deployment_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_intervention_open_review_unique" ON "ota_interventions" USING btree ("deployment_id") WHERE "ota_interventions"."kind"='HUMAN_REVIEW' AND "ota_interventions"."finished_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION protect_ota_intervention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.kind <> 'HUMAN_REVIEW' OR OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL
       OR (to_jsonb(NEW) - ARRAY['finished_at','duration_ms','operation_result','completion_reason','resolution_recovery_id','completion_audit_event_id','completion_key','completion_hash']) IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['finished_at','duration_ms','operation_result','completion_reason','resolution_recovery_id','completion_audit_event_id','completion_key','completion_hash']) THEN
      RAISE EXCEPTION 'OTA intervention history is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.event_id=NEW.audit_event_id AND a.target_kind='deployment' AND a.target_id=NEW.deployment_id::text AND a.actor_kind=NEW.actor_kind AND a.actor_id IS NOT DISTINCT FROM NEW.actor_id AND a.metadata->>'interventionId'=NEW.intervention_id::text) THEN
    RAISE EXCEPTION 'OTA intervention audit mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.completion_audit_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.event_id=NEW.completion_audit_event_id AND a.action='deployment.intervention_completed' AND a.target_id=NEW.deployment_id::text AND a.actor_kind='anonymous' AND a.actor_id IS NULL AND a.metadata->>'interventionId'=NEW.intervention_id::text) THEN
    RAISE EXCEPTION 'OTA intervention completion audit mismatch' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(NEW.scope)<>'array' OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.scope) s WHERE NOT EXISTS (
      SELECT 1 FROM ota_targets t JOIN ota_attempts a ON a.target_id=t.target_id
      WHERE t.deployment_id=NEW.deployment_id AND t.target_id::text=s->>'targetId' AND a.attempt_id::text=s->>'attemptId'
        AND (NEW.stage_id IS NULL OR t.stage_id=NEW.stage_id)
    )
  ) OR (NEW.action_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ota_actions a WHERE a.action_id=NEW.action_id AND a.deployment_id=NEW.deployment_id))
    OR (NEW.recovery_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ota_recoveries r WHERE r.recovery_id=NEW.recovery_id AND r.deployment_id=NEW.deployment_id AND r.target_id=NEW.target_id AND COALESCE(r.attempt_id,r.previous_attempt_id)=NEW.attempt_id))
    OR (NEW.resolution_recovery_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ota_recoveries r WHERE r.recovery_id=NEW.resolution_recovery_id AND r.deployment_id=NEW.deployment_id AND r.attempt_id IS NOT NULL AND r.approved_at>=NEW.started_at)) THEN
    RAISE EXCEPTION 'OTA intervention scope mismatch' USING ERRCODE='23514';
  END IF;
  IF (NEW.kind='HUMAN_REVIEW' AND (
      (NEW.finished_at IS NULL AND (NEW.operation_result<>'OPEN' OR NEW.completion_audit_event_id IS NOT NULL OR NEW.duration_ms IS NOT NULL)) OR
      (NEW.finished_at IS NOT NULL AND (NEW.operation_result NOT IN ('KEEP_STOPPED','ESCALATED','RECOVERY_REQUESTED') OR NEW.completion_audit_event_id IS NULL OR NEW.completion_reason IS NULL OR NEW.completion_key IS NULL OR NEW.completion_hash IS NULL)) OR
      ((NEW.operation_result='RECOVERY_REQUESTED') IS DISTINCT FROM (NEW.resolution_recovery_id IS NOT NULL)) OR NEW.key IS NULL OR NEW.request_hash IS NULL
    )) OR (NEW.kind<>'HUMAN_REVIEW' AND (NEW.finished_at IS NULL OR NEW.operation_result NOT IN ('ACCEPTED','REJECTED') OR NEW.duration_ms IS NOT NULL OR NEW.completion_audit_event_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'OTA intervention result mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ota_intervention_immutable BEFORE INSERT OR UPDATE ON ota_interventions FOR EACH ROW EXECUTE FUNCTION protect_ota_intervention();
