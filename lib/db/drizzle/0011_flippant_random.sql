DROP INDEX "metric_targets_territory_unique";--> statement-breakpoint
DROP INDEX "metric_targets_global_unique";--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN "pam_user_id" uuid;--> statement-breakpoint
ALTER TABLE "metric_targets" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_pam_user_id_users_id_fk" FOREIGN KEY ("pam_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Stage 6.2 backfill: a pre-6.2 metric_targets row was territory-scoped
-- only. Assign pam_user_id ONLY where the territory's canonical owner
-- (territories.owner_user_id) is unambiguous. A territory-scoped row whose
-- territory has no owner, and every Global row (territory_id IS NULL, no
-- single accountable PAM), are deliberately left with pam_user_id NULL --
-- preserved as orphaned/legacy data, never guessed. See the Stage 6.2
-- final report for exactly which rows (if any) were left unassigned.
UPDATE "metric_targets"
SET "pam_user_id" = "territories"."owner_user_id"
FROM "territories"
WHERE "metric_targets"."territory_id" = "territories"."id"
  AND "territories"."owner_user_id" IS NOT NULL
  AND "metric_targets"."pam_user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_targets_pam_territory_unique" ON "metric_targets" USING btree ("metric_key","period","pam_user_id","territory_id");