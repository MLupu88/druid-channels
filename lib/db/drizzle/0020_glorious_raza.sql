CREATE TABLE "discovery_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"territory_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"company_id" uuid,
	"reason" text NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"restored_at" timestamp with time zone,
	"restored_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "discovery_exclusions" ADD CONSTRAINT "discovery_exclusions_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_exclusions" ADD CONSTRAINT "discovery_exclusions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_exclusions" ADD CONSTRAINT "discovery_exclusions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_exclusions" ADD CONSTRAINT "discovery_exclusions_restored_by_user_id_users_id_fk" FOREIGN KEY ("restored_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;