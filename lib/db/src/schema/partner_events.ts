import { pgTable, text, uuid, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { territoriesTable } from "./territories";

// Public events relevant to a partner or territory, shown on the Partners
// briefing page (not the marketing Activities list, which tracks DRUID's own
// joint campaigns/events/webinars).
export const partnerEventsTable = pgTable("partner_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").references(() => companiesTable.id, { onDelete: "cascade" }),
  territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
  name: text("name").notNull(),
  eventDate: date("event_date", { mode: "string" }),
  location: text("location"),
  whyItMatters: text("why_it_matters").notNull(),
  suggestedAction: text("suggested_action", {
    enum: ["meet_there", "attend_together", "speak_together", "sourcing_opportunity"],
  }).notNull().default("sourcing_opportunity"),
  sourceUrl: text("source_url"),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPartnerEventSchema = createInsertSchema(partnerEventsTable).omit({ id: true, discoveredAt: true });
export type InsertPartnerEvent = z.infer<typeof insertPartnerEventSchema>;
export type PartnerEvent = typeof partnerEventsTable.$inferSelect;
