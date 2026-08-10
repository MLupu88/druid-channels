ALTER TABLE "scan_runs" ADD COLUMN "queries_run" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "unique_companies_seen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "new_companies_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "duplicates_removed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "candidates_sent_to_llm" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "candidates_qualified" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "stopped_reason" text;