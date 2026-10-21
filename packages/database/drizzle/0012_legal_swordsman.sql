CREATE TABLE "releases" (
	"release_id" uuid PRIMARY KEY NOT NULL,
	"application" text NOT NULL,
	"version" text NOT NULL,
	"platform" text NOT NULL,
	"digest" varchar(64) NOT NULL,
	"envelope" jsonb NOT NULL,
	"verified_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"verification" text DEFAULT 'VERIFIED' NOT NULL,
	"actor_kind" text DEFAULT 'anonymous' NOT NULL,
	"actor_id" text,
	CONSTRAINT "releases_verification_valid" CHECK ("releases"."verification"='VERIFIED'),
	CONSTRAINT "releases_actor_valid" CHECK ("releases"."actor_kind"='anonymous' AND "releases"."actor_id" IS NULL),
	CONSTRAINT "releases_digest_valid" CHECK ("releases"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_target_valid";--> statement-breakpoint
CREATE UNIQUE INDEX "releases_application_version_platform_unique" ON "releases" USING btree ("application","version","platform");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_valid" CHECK ("audit_logs"."target_kind" IN ('group','device','command','operation','alert','release'));
--> statement-breakpoint
-- deploymentの実装前から全releaseを保持する。参照中も例外なく変更/削除不可。
CREATE FUNCTION reject_release_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'release is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER releases_immutable BEFORE UPDATE OR DELETE ON releases
FOR EACH ROW EXECUTE FUNCTION reject_release_mutation();
--> statement-breakpoint
CREATE TRIGGER releases_no_truncate BEFORE TRUNCATE ON releases
FOR EACH STATEMENT EXECUTE FUNCTION reject_release_mutation();
