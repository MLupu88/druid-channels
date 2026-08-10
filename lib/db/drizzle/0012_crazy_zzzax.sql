DROP INDEX "metric_targets_pam_territory_unique";--> statement-breakpoint
DROP INDEX "ai_channel_briefs_territory_unique";--> statement-breakpoint
DROP INDEX "ai_channel_briefs_global_unique";--> statement-breakpoint
-- Stage 6.3: added nullable first (not a one-shot NOT NULL add), backfilled,
-- then locked to NOT NULL -- safe against non-empty tables. Every pre-6.3
-- row is unambiguously year=2026 (the only year this app has ever run
-- under, per kpiRegistry's previously-hardcoded PERIODS) -- never guessed,
-- just the one true value for all existing data.
ALTER TABLE "manual_metric_values" ADD COLUMN "year" integer;--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN "year" integer;--> statement-breakpoint
ALTER TABLE "ai_channel_briefs" ADD COLUMN "year" integer;--> statement-breakpoint
UPDATE "manual_metric_values" SET "year" = 2026 WHERE "year" IS NULL;--> statement-breakpoint
UPDATE "metric_targets" SET "year" = 2026 WHERE "year" IS NULL;--> statement-breakpoint
UPDATE "ai_channel_briefs" SET "year" = 2026 WHERE "year" IS NULL;--> statement-breakpoint
ALTER TABLE "manual_metric_values" ALTER COLUMN "year" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_targets" ALTER COLUMN "year" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_channel_briefs" ALTER COLUMN "year" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_targets_pam_territory_unique" ON "metric_targets" USING btree ("metric_key","year","period","pam_user_id","territory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_channel_briefs_territory_unique" ON "ai_channel_briefs" USING btree ("year","period","territory_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_channel_briefs_global_unique" ON "ai_channel_briefs" USING btree ("year","period","currency") WHERE "ai_channel_briefs"."territory_id" is null;
