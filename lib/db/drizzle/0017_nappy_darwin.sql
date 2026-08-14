CREATE TABLE "channel_radar_signal_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"source_title" text NOT NULL,
	"source_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"source_domain" text,
	"source_published_at" date,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD COLUMN "druid_partner_motion" text;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD COLUMN "requires_validation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD COLUMN "regional_applicability_certain" boolean;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD COLUMN "related_entity_name" text;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD COLUMN "related_entity_type" text;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD COLUMN "related_entity_company_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD COLUMN "relationship_label" text;--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD COLUMN "last_evidence_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_radar_signal_evidence" ADD CONSTRAINT "channel_radar_signal_evidence_signal_id_channel_radar_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."channel_radar_signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_radar_signal_evidence_signal_url_unique" ON "channel_radar_signal_evidence" USING btree ("signal_id","normalized_url");--> statement-breakpoint
ALTER TABLE "channel_radar_signals" ADD CONSTRAINT "channel_radar_signals_related_entity_company_id_companies_id_fk" FOREIGN KEY ("related_entity_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;