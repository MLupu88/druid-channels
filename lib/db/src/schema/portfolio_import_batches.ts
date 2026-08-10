import { pgTable, text, uuid, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";
import { usersTable } from "./users";

// A PAM Portfolio import run. The raw source file itself is never
// persisted here (or anywhere) -- only small structured per-row data lives
// in portfolio_import_rows.source_raw. See portfolioImportEngine.ts for the
// row-count cap (v1: 300) enforced at creation time.
export const PORTFOLIO_IMPORT_SOURCE_FORMATS = ["excel", "csv", "pasted_text"] as const;
export const PORTFOLIO_IMPORT_BATCH_STATUSES = ["processing", "ready_for_review", "completed", "failed"] as const;

export const portfolioImportBatchesTable = pgTable("portfolio_import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
  createdByUserId: uuid("created_by_user_id").references(() => usersTable.id),
  sourceFormat: text("source_format", { enum: PORTFOLIO_IMPORT_SOURCE_FORMATS }).notNull(),
  originalFilename: text("original_filename"),
  rowCount: integer("row_count").notNull().default(0),
  status: text("status", { enum: PORTFOLIO_IMPORT_BATCH_STATUSES }).notNull().default("processing"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertPortfolioImportBatchSchema = createInsertSchema(portfolioImportBatchesTable).omit({ id: true, createdAt: true });
export type InsertPortfolioImportBatch = z.infer<typeof insertPortfolioImportBatchSchema>;
export type PortfolioImportBatch = typeof portfolioImportBatchesTable.$inferSelect;
