import { pgTable, uuid, primaryKey } from "drizzle-orm/pg-core";
import { campaignsTable } from "./campaigns";
import { prospectsTable } from "./prospects";

export const campaignProspectsTable = pgTable("campaign_prospects", {
  campaignId: uuid("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  prospectId: uuid("prospect_id").notNull().references(() => prospectsTable.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.campaignId, t.prospectId] })]);
