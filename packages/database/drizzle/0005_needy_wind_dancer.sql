CREATE TABLE "group_memberships" (
	"group_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_memberships_group_id_device_id_pk" PRIMARY KEY("group_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"group_id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(1000),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "groups_name_valid" CHECK (length(btrim("groups"."name")) BETWEEN 1 AND 100 AND "groups"."name" = btrim("groups"."name") AND "groups"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "groups_revision_positive" CHECK ("groups"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("group_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_memberships_device_idx" ON "group_memberships" USING btree ("device_id","group_id");--> statement-breakpoint
CREATE INDEX "groups_active_created_idx" ON "groups" USING btree ("created_at","group_id") WHERE "groups"."deleted_at" IS NULL;