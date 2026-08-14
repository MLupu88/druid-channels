CREATE TABLE "weekly_pam_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pam_user_id" uuid NOT NULL,
	"territory_ids" jsonb NOT NULL,
	"week_start_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"metrics_snapshot" jsonb,
	"snapshot_generated_at" timestamp with time zone,
	"wins_progress" text,
	"risks_blockers" text,
	"priorities_next_week" text,
	"help_needed" text,
	"commentary_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_pam_reports_submitted_requires_snapshot" CHECK ("weekly_pam_reports"."status" <> 'submitted' or ("weekly_pam_reports"."metrics_snapshot" is not null and "weekly_pam_reports"."snapshot_generated_at" is not null and "weekly_pam_reports"."submitted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "weekly_pam_reports" ADD CONSTRAINT "weekly_pam_reports_pam_user_id_users_id_fk" FOREIGN KEY ("pam_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_pam_reports_pam_week_unique" ON "weekly_pam_reports" USING btree ("pam_user_id","week_start_date");