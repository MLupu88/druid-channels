CREATE TABLE "ai_channel_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" text NOT NULL,
	"territory_id" uuid,
	"currency" text NOT NULL,
	"content" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"data_as_of" timestamp with time zone,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_channel_briefs" ADD CONSTRAINT "ai_channel_briefs_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_channel_briefs" ADD CONSTRAINT "ai_channel_briefs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_channel_briefs_territory_unique" ON "ai_channel_briefs" USING btree ("period","territory_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_channel_briefs_global_unique" ON "ai_channel_briefs" USING btree ("period","currency") WHERE "ai_channel_briefs"."territory_id" is null;