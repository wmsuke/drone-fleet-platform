ALTER TABLE "ota_evaluations" ADD COLUMN "revision" bigserial NOT NULL;
--> statement-breakpoint
ALTER TABLE ota_evaluations DISABLE TRIGGER ota_evaluation_immutable;
--> statement-breakpoint
WITH ordered AS (
  SELECT evaluation_id, row_number() OVER (ORDER BY evaluated_at, evaluation_id) AS n FROM ota_evaluations
) UPDATE ota_evaluations e SET revision = o.n FROM ordered o WHERE e.evaluation_id = o.evaluation_id;
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('ota_evaluations','revision'), GREATEST((SELECT count(*) FROM ota_evaluations),1), EXISTS(SELECT 1 FROM ota_evaluations));
--> statement-breakpoint
ALTER TABLE ota_evaluations ENABLE TRIGGER ota_evaluation_immutable;
