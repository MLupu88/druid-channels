CREATE TABLE "channel_radar_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"territory_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"monitored_entities" json DEFAULT '[]'::json NOT NULL,
	"enabled_signal_types" json DEFAULT '[]'::json NOT NULL,
	"lookback_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_radar_configs_territory_id_unique" UNIQUE("territory_id")
);
--> statement-breakpoint
CREATE TABLE "channel_radar_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"territory_id" uuid NOT NULL,
	"assigned_user_id" uuid,
	"company_id" uuid,
	"entity_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"signal_type" text NOT NULL,
	"headline" text NOT NULL,
	"summary" text NOT NULL,
	"why_it_matters" text NOT NULL,
	"implication" text NOT NULL,
	"impact" text NOT NULL,
	"recommended_action" text NOT NULL,
	"confidence" text NOT NULL,
	"source_title" text NOT NULL,
	"source_url" text NOT NULL,
	"source_domain" text,
	"source_published_at" date,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_radar_signals_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "channel_radar_configs" ADD CONSTRAINT "channel_radar_configs_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD CONSTRAINT "channel_radar_signals_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD CONSTRAINT "channel_radar_signals_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD CONSTRAINT "channel_radar_signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;