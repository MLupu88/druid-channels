CREATE TABLE "campaign_opportunities" (
	"campaign_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_opportunities_campaign_id_opportunity_id_pk" PRIMARY KEY("campaign_id","opportunity_id")
);
--> statement-breakpoint
ALTER TABLE "campaign_opportunities" ADD CONSTRAINT "campaign_opportunities_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_opportunities" ADD CONSTRAINT "campaign_opportunities_opportunity_id_partner_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."partner_opportunities"("id") ON DELETE cascade ON UPDATE no action;