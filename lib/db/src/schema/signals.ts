import { pgTable, text, uuid, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const signalsTable = pgTable("signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  signalType: text("signal_type", {
    enum: ["partnership", "ai_investment", "enterprise_access", "technology", "hiring", "event", "tender"],
  }).notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceDomain: text("source_domain"),
  publishedAt: date("published_at", { mode: "string" }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  confidence: text("confidence", { enum: ["high", "medium", "low"] }).notNull().default("medium"),
  rawExcerpt: text("raw_excerpt"),
});

export const insertSignalSchema = createInsertSchema(signalsTable).omit({ id: true, discoveredAt: true });
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Signal = typeof signalsTable.$inferSelect;
