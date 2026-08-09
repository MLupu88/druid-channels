CREATE TABLE "metric_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_key" text NOT NULL,
	"period" text NOT NULL,
	"territory_id" uuid,
	"target_value" numeric NOT NULL,
	"note" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_targets" ADD CONSTRAINT "metric_targets_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_targets_territory_unique" ON "metric_targets" USING btree ("metric_key","period","territory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_targets_global_unique" ON "metric_targets" USING btree ("metric_key","period") WHERE "metric_targets"."territory_id" is null;