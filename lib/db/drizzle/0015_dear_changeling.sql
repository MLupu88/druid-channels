CREATE TABLE "partner_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"company_id" uuid NOT NULL,
	"territory_id" uuid NOT NULL,
	"assigned_user_id" uuid NOT NULL,
	"attribution_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"deal_value" numeric NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"opportunity_date" date NOT NULL,
	"expected_close_date" date,
	"closed_at" timestamp with time zone,
	"credit_value" numeric,
	"credit_date" date,
	"customer_name" text,
	"note" text,
	"source_system" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"source_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_opportunities_deal_value_positive" CHECK ("partner_opportunities"."deal_value" > 0),
	CONSTRAINT "partner_opportunities_credit_value_positive" CHECK ("partner_opportunities"."credit_value" is null or "partner_opportunities"."credit_value" > 0)
);
--> statement-breakpoint
ALTER TABLE "partner_opportunities" ADD CONSTRAINT "partner_opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_opportunities" ADD CONSTRAINT "partner_opportunities_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_opportunities" ADD CONSTRAINT "partner_opportunities_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_opportunities" ADD CONSTRAINT "partner_opportunities_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_opportunities_source_external_unique" ON "partner_opportunities" USING btree ("source_system","external_id") WHERE "partner_opportunities"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_targets_global_annual_unique" ON "metric_targets" USING btree ("metric_key","year") WHERE "metric_targets"."pam_user_id" is null and "metric_targets"."territory_id" is null and "metric_targets"."period" = 'annual';