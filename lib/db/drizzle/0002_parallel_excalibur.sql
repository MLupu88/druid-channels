ALTER TABLE "prospects" ADD COLUMN "discovery_source_status" text DEFAULT 'demo' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "data_status" text DEFAULT 'demo' NOT NULL;