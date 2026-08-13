import { pgTable, uuid, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { campaignsTable } from "./campaigns";
import { partnerOpportunitiesTable } from "./partner_opportunities";

// Phase 6: the only linkage between a marketing activity and the Phase 5A
// commercial ledger. Deliberately a separate join table rather than a
// column on either side -- a campaign may have zero-to-many linked
// opportunities, and the same opportunity may legitimately be linked from
// more than one campaign (e.g. a deal touched by both an event and a later
// webinar), so neither side could hold a single foreign key. No column is
// added to partnerOpportunitiesTable, and this table carries no commercial
// fields of its own (deal_value, credit_value, closed_at, attribution_type,
// etc. all stay exclusively on partner_opportunities) -- pipeline/closed
// revenue for a campaign are always DERIVED by joining through here at read
// time (see services/campaignService.ts), never persisted here or on
// campaigns. Cascade both directions: deleting either side of a link
// should silently drop the association, never block the delete.
export const campaignOpportunitiesTable = pgTable(
  "campaign_opportunities",
  {
    campaignId: uuid("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id").notNull().references(() => partnerOpportunitiesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.opportunityId] })],
);

export const insertCampaignOpportunitySchema = createInsertSchema(campaignOpportunitiesTable).omit({ createdAt: true });
export type InsertCampaignOpportunity = z.infer<typeof insertCampaignOpportunitySchema>;
export type CampaignOpportunity = typeof campaignOpportunitiesTable.$inferSelect;
