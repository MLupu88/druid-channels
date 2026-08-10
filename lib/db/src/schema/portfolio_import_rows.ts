import { pgTable, text, uuid, timestamp, integer, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { portfolioImportBatchesTable } from "./portfolio_import_batches";
import { companiesTable } from "./companies";
import { partnerRelationshipsTable } from "./partner_relationships";
import { usersTable } from "./users";

// One row of a PAM Portfolio import. Carries all three provenance layers
// required for Stage 6: source_raw (layer 1, original), normalized_proposal
// (layer 2, deterministic + DeepSeek output), and resulting_relationship_id
// (layer 3, canonical -- set once the PAM confirms). Deliberately no FK
// back from partner_relationships to this table (no circular reference,
// this row is a leaf table); the originating row is found by querying
// portfolio_import_rows.resulting_relationship_id instead.
export const PORTFOLIO_IMPORT_MATCH_STATUSES = [
  "ready",
  "matched_existing_company",
  "possible_duplicate",
  "existing_relationship",
  "needs_review",
  "invalid",
] as const;

export const portfolioImportRowsTable = pgTable("portfolio_import_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").notNull().references(() => portfolioImportBatchesTable.id, { onDelete: "cascade" }),
  rowIndex: integer("row_index").notNull(),
  // Layer 1: the original row exactly as received from the client-parsed
  // spreadsheet/pasted text (header -> value map, or a single text field
  // for pasted_text). Bounded per-row, never a whole file.
  sourceRaw: json("source_raw").$type<Record<string, string>>().notNull().default({}),
  // Layer 2: deterministic extraction + DeepSeek normalization output.
  // Null until the normalization pass has run.
  normalizedProposal: json("normalized_proposal").$type<Record<string, unknown> | null>(),
  matchStatus: text("match_status", { enum: PORTFOLIO_IMPORT_MATCH_STATUSES }).notNull().default("needs_review"),
  matchedCompanyId: uuid("matched_company_id").references(() => companiesTable.id),
  reviewNote: text("review_note"),
  // Layer 3: set once the PAM confirms this row into the canonical model.
  resultingRelationshipId: uuid("resulting_relationship_id").references(() => partnerRelationshipsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => usersTable.id),
});

export const insertPortfolioImportRowSchema = createInsertSchema(portfolioImportRowsTable).omit({ id: true, createdAt: true });
export type InsertPortfolioImportRow = z.infer<typeof insertPortfolioImportRowSchema>;
export type PortfolioImportRow = typeof portfolioImportRowsTable.$inferSelect;
