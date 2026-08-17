CREATE TABLE "discovery_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"outcome" text NOT NULL,
	"territory_id" uuid NOT NULL,
	"scan_run_id" uuid NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "candidates_skipped_recent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_evaluations" ADD CONSTRAINT "discovery_evaluations_territory_id_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."territories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_evaluations" ADD CONSTRAINT "discovery_evaluations_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_evaluations_domain_idx" ON "discovery_evaluations" USING btree ("domain");