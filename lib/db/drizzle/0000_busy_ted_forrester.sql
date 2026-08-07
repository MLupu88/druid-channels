CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'pam' NOT NULL,
	"territory" text,
	"active" boolean DEFAULT true NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "territories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"countries" json DEFAULT '[]'::json NOT NULL,
	"languages" json DEFAULT '[]'::json NOT NULL,
	CONSTRAINT "territories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text,
	"domain" text NOT NULL,
	"website_url" text,
	"country" text NOT NULL,
	"headquarters" text,
	"employee_band" text,
	"description" text,
	"linkedin_url" text,
	"hubspot_company_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"source_url" text NOT NULL,
	"source_domain" text,
	"published_at" date,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"raw_excerpt" text
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"territory_id" uuid NOT NULL,
	"assigned_user_id" uuid,
	"partner_type" text NOT NULL,
	"priority" text NOT NULL,
	"enterprise_access" boolean DEFAULT false NOT NULL,
	"relevant_capability" boolean DEFAULT false NOT NULL,
	"technology_adjacency" boolean DEFAULT false NOT NULL,
	"partnership_openness" boolean DEFAULT false NOT NULL,
	"recent_trigger" boolean DEFAULT false NOT NULL,
	"why_it_fits" text NOT NULL,
	"why_now" text NOT NULL,
	"suggested_angle" text,
	"suggested_target_role" text,
	"suggested_message" text,
	"status" text DEFAULT 'new' NOT NULL,
	"rejection_reason" text,
	"pam_note" text,
	"accepted_at" timestamp with time zone,
	"hubspot_company_id" text,
	"help_needed_type" text DEFAULT 'none' NOT NULL,
	"help_needed_note" text,
	"last_researched_at" timestamp with time zone,
	"pipeline_sourced" numeric,
	"pipeline_influenced" numeric,
	"revenue_closed" numeric,
	"renewal_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"event_type" text NOT NULL,
	"note" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"territory_id" uuid NOT NULL,
	"name" text NOT NULL,
	"search_queries" json DEFAULT '[]'::json NOT NULL,
	"partner_types" json DEFAULT '[]'::json NOT NULL,
	"industries" json DEFAULT '[]'::json NOT NULL,
	"technologies" json DEFAULT '[]'::json NOT NULL,
	"excluded_domains" json DEFAULT '[]'::json NOT NULL,
	"target_signals" json DEFAULT '["new_partners","rfps","events","ai_moves","customer_wins","partnerships"]'::json NOT NULL,
	"max_results" integer DEFAULT 25 NOT NULL,
	"min_checks_required" integer DEFAULT 3 NOT NULL,
	"recency_window_days" integer DEFAULT 90 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_config_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"results_found" integer DEFAULT 0 NOT NULL,
	"results_qualified" integer DEFAULT 0 NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'joint_campaign' NOT NULL,
	"territory" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"partner_company_id" uuid,
	"activity_date" date,
	"status" text DEFAULT 'planned' NOT NULL,
	"hubspot_link" text,
	"mqls" integer DEFAULT 0 NOT NULL,
	"partner_referrals" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kpi_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"territory_id" uuid,
	"metric_name" text NOT NULL,
	"current_value" numeric NOT NULL,
	"target_value" numeric NOT NULL,
	"last_week_value" numeric,
	"status" text DEFAULT 'amber' NOT NULL,
	"explanation" text,
	"what_changed" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_research_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category" text NOT NULL,
	"source_kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"is_possible_customer_opening" boolean DEFAULT false NOT NULL,
	"source_url" text,
	"source_domain" text,
	"published_at" date,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"country" text NOT NULL,
	"deadline" date,
	"why_relevant" text NOT NULL,
	"source_url" text,
	"source_domain" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"territory_id" uuid NOT NULL,
	"name" text NOT NULL,
	"event_date" date,
	"location" text,
	"why_it_matters" text NOT NULL,
	"suggested_action" text DEFAULT 'sourcing_opportunity' NOT NULL,
	"source_url" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_type" text NOT NULL,
	"provider_name" text NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"config_json" json DEFAULT '{}'::json NOT NULL,
	"credential_env_var" text,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_provider_type_unique" UNIQUE("provider_type")
);
--> statement-breakpoint
CREATE TABLE "metric_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_key" text NOT NULL,
	"source_type" text NOT NULL,
	"connection_id" uuid,
	"mapping_json" json,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_mappings_metric_key_unique" UNIQUE("metric_key")
);
--> statement-breakpoint
CREATE TABLE "manual_metric_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_key" text NOT NULL,
	"period" text NOT NULL,
	"territory_id" uuid,
	"current_value" numeric NOT NULL,
	"target_value" numeric,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_activity" ADD CONSTRAINT "prospect_activity_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_activity" ADD CONSTRAINT "prospect_activity_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_configs" ADD CONSTRAINT "scan_configs_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_scan_config_id_scan_configs_id_fk" FOREIGN KEY ("scan_config_id") REFERENCES "public"."scan_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_partner_company_id_companies_id_fk" FOREIGN KEY ("partner_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_research_items" ADD CONSTRAINT "partner_research_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfps" ADD CONSTRAINT "rfps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_events" ADD CONSTRAINT "partner_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_events" ADD CONSTRAINT "partner_events_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_mappings" ADD CONSTRAINT "metric_mappings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_metric_values" ADD CONSTRAINT "manual_metric_values_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE cascade ON UPDATE no action;