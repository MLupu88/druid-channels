ALTER TABLE "connections" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "secret_last4" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "encryption_key_version" integer;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;