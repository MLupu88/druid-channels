import { pgTable, text, uuid, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { scanConfigsTable } from "./scan_configs";

// Stage 6.5: run-level search-productivity stats, additive to the existing
// resultsFound/resultsQualified pair -- needed for Territory Potential's
// saturation calculation and the cost-aware adaptive discovery loop (see
// discoveryBudget.ts/discoveryEngine.ts). All default to 0/null so existing
// rows (and every demo-mode run, which never runs the adaptive loop) stay
// honestly "no real search productivity data" rather than fabricated.
// Production hotfix: widened with bounded, non-sensitive AI/search failure
// classifications (see discoveryEngine.ts's classifyDiscoveryFailure) so a
// genuine provider failure's stopped_reason is diagnosable without ever
// persisting a raw provider error/response. `enum` here is a drizzle-orm
// TypeScript-level constraint on a plain `text` column -- it does not
// generate a Postgres CHECK constraint, so widening this array is a
// source-only change; no migration is needed.
export const SCAN_RUN_STOPPED_REASONS = [
  "budget_exhausted",
  "saturation",
  "completed",
  "manual",
  "error",
  "ai_timeout",
  "ai_network_error",
  "ai_http_error",
  "ai_oversized_response",
  "ai_malformed_response",
  "ai_empty_response",
  "ai_truncated_response",
  "ai_schema_invalid",
  "search_timeout",
  "search_network_error",
  "search_http_error",
  "search_oversized_response",
  "search_malformed_response",
] as const;

export const scanRunsTable = pgTable("scan_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanConfigId: uuid("scan_config_id").notNull().references(() => scanConfigsTable.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull().default("queued"),
  resultsFound: integer("results_found").notNull().default(0),
  resultsQualified: integer("results_qualified").notNull().default(0),
  errorMessage: text("error_message"),
  // "connected" only when every stage (search, extraction, AI structuring)
  // actually ran against a live provider; "demo" whenever any stage fell
  // back to the deterministic generator. Never fabricated as "connected".
  dataStatus: text("data_status", { enum: ["demo", "connected"] }).notNull().default("demo"),
  // Stage 6.5 additions below -- only ever populated on the live
  // (dataStatus="connected") adaptive-discovery path; a demo run leaves
  // these at their defaults, which Territory Potential's saturation logic
  // treats as "not real search productivity data", never as zero yield.
  queriesRun: integer("queries_run").notNull().default(0),
  uniqueCompaniesSeen: integer("unique_companies_seen").notNull().default(0),
  newCompaniesCount: integer("new_companies_count").notNull().default(0),
  duplicatesRemoved: integer("duplicates_removed").notNull().default(0),
  candidatesSentToLlm: integer("candidates_sent_to_llm").notNull().default(0),
  // Passed the 5-check qualification bar (qualifyChecks), *before* the
  // company-dedupe gate in persistCandidate -- resultsQualified above stays
  // the final persisted/accepted count, unchanged in meaning.
  candidatesQualified: integer("candidates_qualified").notNull().default(0),
  stoppedReason: text("stopped_reason", { enum: SCAN_RUN_STOPPED_REASONS }),
});

export const insertScanRunSchema = createInsertSchema(scanRunsTable).omit({ id: true, startedAt: true });
export type InsertScanRun = z.infer<typeof insertScanRunSchema>;
export type ScanRun = typeof scanRunsTable.$inferSelect;
