CREATE TABLE "fx_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate" numeric NOT NULL,
	"source" text NOT NULL,
	"as_of" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kpi_snapshots" ALTER COLUMN "target_value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kpi_snapshots" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_snapshots_base_quote_as_of_unique" ON "fx_snapshots" USING btree ("base_currency","quote_currency","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_snapshots_territory_period_unique" ON "kpi_snapshots" USING btree ("metric_name","territory_id","period_start") WHERE "kpi_snapshots"."territory_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_snapshots_global_period_unique" ON "kpi_snapshots" USING btree ("metric_name","period_start") WHERE "kpi_snapshots"."territory_id" IS NULL;--> statement-breakpoint
-- One-time Stage 2B data migration: move the five newly-live metrics off
-- their originally-seeded DEMO mapping to PARTNER_RADAR, but only for rows
-- that have never been touched since that seed insert (created_at =
-- updated_at). A row an admin has since modified -- even if it still reads
-- DEMO -- is left alone, since we cannot know whether that was intentional.
UPDATE "metric_mappings"
SET "source_type" = 'PARTNER_RADAR', "updated_at" = now()
WHERE "metric_key" IN ('signed_partners', 'partner_sourced_pipeline', 'partner_influenced_pipeline', 'closed_revenue', 'renewals')
  AND "source_type" = 'DEMO'
  AND "created_at" = "updated_at";