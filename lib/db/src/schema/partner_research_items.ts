import { pgTable, text, uuid, timestamp, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Research items shown on the "Partners" briefing page for an existing partner:
// what changed since last research, what they're doing, customer/market access
// openings, and AI/business updates. Every item is labeled by where it came
// from so AI interpretation is never presented as verified fact.
export const partnerResearchItemsTable = pgTable("partner_research_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  category: text("category", {
    enum: ["what_changed", "whats_happening", "customer_access", "ai_update"],
  }).notNull(),
  sourceKind: text("source_kind", {
    enum: ["public_source", "ai_summary", "hubspot_data", "pam_note"],
  }).notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  isPossibleCustomerOpening: boolean("is_possible_customer_opening").notNull().default(false),
  sourceUrl: text("source_url"),
  sourceDomain: text("source_domain"),
  publishedAt: date("published_at", { mode: "string" }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPartnerResearchItemSchema = createInsertSchema(partnerResearchItemsTable).omit({ id: true, discoveredAt: true });
export type InsertPartnerResearchItem = z.infer<typeof insertPartnerResearchItemSchema>;
export type PartnerResearchItem = typeof partnerResearchItemsTable.$inferSelect;
