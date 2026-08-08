import { pgTable, text, uuid, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { scanConfigsTable } from "./scan_configs";

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
});

export const insertScanRunSchema = createInsertSchema(scanRunsTable).omit({ id: true, startedAt: true });
export type InsertScanRun = z.infer<typeof insertScanRunSchema>;
export type ScanRun = typeof scanRunsTable.$inferSelect;
