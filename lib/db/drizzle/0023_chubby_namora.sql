CREATE TABLE "druid_context_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"extracted_text" text NOT NULL,
	"review_status" text DEFAULT 'pending_review' NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "druid_facts" ADD COLUMN "source_context_id" uuid;--> statement-breakpoint
ALTER TABLE "druid_context_sources" ADD CONSTRAINT "druid_context_sources_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "druid_context_sources_normalized_url_content_hash_unique" ON "druid_context_sources" USING btree ("normalized_url","content_hash");--> statement-breakpoint
ALTER TABLE "druid_facts" ADD CONSTRAINT "druid_facts_source_context_id_druid_context_sources_id_fk" FOREIGN KEY ("source_context_id") REFERENCES "public"."druid_context_sources"("id") ON DELETE no action ON UPDATE no action;