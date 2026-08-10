CREATE TABLE "partner_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"territory_id" uuid NOT NULL,
	"assigned_user_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"partner_type" text,
	"strategic_importance" text,
	"relationship_summary" text,
	"relationship_started_at" date,
	"started_at_precision" text DEFAULT 'unknown' NOT NULL,
	"started_at_provenance" text,
	"relationship_ended_at" date,
	"last_interaction_at" timestamp with time zone,
	"next_action" text,
	"next_action_due_at" date,
	"origin_type" text NOT NULL,
	"origin_recruitment_id" uuid,
	"source_as_of_date" date,
	"imported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_relationships_company_territory_unique" UNIQUE("company_id","territory_id")
);
--> statement-breakpoint
CREATE TABLE "partner_relationship_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"from_user_id" uuid,
	"to_user_id" uuid,
	"source_recruitment_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"changed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"activity_type" text NOT NULL,
	"note" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"territory_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"source_format" text NOT NULL,
	"original_filename" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "portfolio_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"source_raw" json DEFAULT '{}'::json NOT NULL,
	"normalized_proposal" json,
	"match_status" text DEFAULT 'needs_review' NOT NULL,
	"matched_company_id" uuid,
	"review_note" text,
	"resulting_relationship_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "partner_relationships" ADD CONSTRAINT "partner_relationships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_relationships" ADD CONSTRAINT "partner_relationships_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_relationships" ADD CONSTRAINT "partner_relationships_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_relationships" ADD CONSTRAINT "partner_relationships_origin_recruitment_id_partner_recruitments_id_fk" FOREIGN KEY ("origin_recruitment_id") REFERENCES "public"."partner_recruitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_relationship_history" ADD CONSTRAINT "partner_relationship_history_relationship_id_partner_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."partner_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_relationship_history" ADD CONSTRAINT "partner_relationship_history_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_relationship_history" ADD CONSTRAINT "partner_relationship_history_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_relationship_history" ADD CONSTRAINT "partner_relationship_history_source_recruitment_id_partner_recruitments_id_fk" FOREIGN KEY ("source_recruitment_id") REFERENCES "public"."partner_recruitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_relationship_history" ADD CONSTRAINT "partner_relationship_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_activities" ADD CONSTRAINT "partner_activities_relationship_id_partner_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."partner_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_activities" ADD CONSTRAINT "partner_activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_import_batches" ADD CONSTRAINT "portfolio_import_batches_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_import_batches" ADD CONSTRAINT "portfolio_import_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_import_rows" ADD CONSTRAINT "portfolio_import_rows_batch_id_portfolio_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."portfolio_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_import_rows" ADD CONSTRAINT "portfolio_import_rows_matched_company_id_companies_id_fk" FOREIGN KEY ("matched_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_import_rows" ADD CONSTRAINT "portfolio_import_rows_resulting_relationship_id_partner_relationships_id_fk" FOREIGN KEY ("resulting_relationship_id") REFERENCES "public"."partner_relationships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_import_rows" ADD CONSTRAINT "portfolio_import_rows_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;