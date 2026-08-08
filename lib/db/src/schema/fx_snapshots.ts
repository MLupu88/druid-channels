import { pgTable, text, uuid, timestamp, numeric, date, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// USD-base reference rates fetched from Frankfurter (frankfurter.app) at
// read time and persisted here for fallback/audit. Application code is
// responsible for restricting base_currency/quote_currency to the
// supported set (USD/EUR/GBP) -- no DB-level enum/check, matching how
// currency-shaped free-text columns are handled elsewhere in this schema.
// Never stores a converted commercial amount -- prospects/kpi_snapshots/
// manual_metric_values remain the USD-canonical source of truth.
export const fxSnapshotsTable = pgTable("fx_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  baseCurrency: text("base_currency").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  rate: numeric("rate").notNull(),
  source: text("source").notNull(),
  asOf: date("as_of", { mode: "string" }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // One rate per currency pair per day -- an upsert-by-day fetch/refresh
  // relies on this to be idempotent at the DB level, not just in app code.
  uniqueIndex("fx_snapshots_base_quote_as_of_unique").on(table.baseCurrency, table.quoteCurrency, table.asOf),
]);

export const insertFxSnapshotSchema = createInsertSchema(fxSnapshotsTable).omit({ id: true, fetchedAt: true });
export type InsertFxSnapshot = z.infer<typeof insertFxSnapshotSchema>;
export type FxSnapshot = typeof fxSnapshotsTable.$inferSelect;
