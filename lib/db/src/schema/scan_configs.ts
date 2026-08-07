import { pgTable, text, uuid, boolean, json, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";

export const scanConfigsTable = pgTable("scan_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
  name: text("name").notNull(),
  searchQueries: json("search_queries").$type<string[]>().notNull().default([]),
  partnerTypes: json("partner_types").$type<string[]>().notNull().default([]),
  industries: json("industries").$type<string[]>().notNull().default([]),
  technologies: json("technologies").$type<string[]>().notNull().default([]),
  excludedDomains: json("excluded_domains").$type<string[]>().notNull().default([]),
  // Categories used by "What to look for": what the scan should watch for per territory.
  targetSignals: json("target_signals").$type<string[]>().notNull().default([
    "new_partners",
    "rfps",
    "events",
    "ai_moves",
    "customer_wins",
    "partnerships",
  ]),
  maxResults: integer("max_results").notNull().default(25),
  minChecksRequired: integer("min_checks_required").notNull().default(3),
  recencyWindowDays: integer("recency_window_days").notNull().default(90),
  active: boolean("active").notNull().default(true),
});

export const insertScanConfigSchema = createInsertSchema(scanConfigsTable).omit({ id: true });
export type InsertScanConfig = z.infer<typeof insertScanConfigSchema>;
export type ScanConfig = typeof scanConfigsTable.$inferSelect;
