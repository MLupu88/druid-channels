CREATE TABLE "druid_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"fact_text" text NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_url" text,
	"source_note" text,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verified_by_user_id" uuid,
	"verified_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_by_user_id" uuid,
	"deactivated_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "druid_facts" ADD CONSTRAINT "druid_facts_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "druid_facts" ADD CONSTRAINT "druid_facts_deactivated_by_user_id_users_id_fk" FOREIGN KEY ("deactivated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "druid_facts" ADD CONSTRAINT "druid_facts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "druid_facts" ADD CONSTRAINT "druid_facts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;