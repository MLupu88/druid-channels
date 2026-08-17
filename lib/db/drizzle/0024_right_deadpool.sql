CREATE TABLE "channel_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"old_values" jsonb,
	"new_values" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "channel_change_events" ADD CONSTRAINT "channel_change_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_change_events_occurred_at_idx" ON "channel_change_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "channel_change_events_entity_idx" ON "channel_change_events" USING btree ("entity_type","entity_id");