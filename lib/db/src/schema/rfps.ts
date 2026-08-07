import { pgTable, text, uuid, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Public RFPs/tenders relevant to an existing partner, shown on the Partners
// briefing page. Always sourced as a public source item with a URL.
export const rfpsTable = pgTable("rfps", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  country: text("country").notNull(),
  deadline: date("deadline", { mode: "string" }),
  whyRelevant: text("why_relevant").notNull(),
  sourceUrl: text("source_url"),
  sourceDomain: text("source_domain"),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRfpSchema = createInsertSchema(rfpsTable).omit({ id: true, discoveredAt: true });
export type InsertRfp = z.infer<typeof insertRfpSchema>;
export type Rfp = typeof rfpsTable.$inferSelect;
