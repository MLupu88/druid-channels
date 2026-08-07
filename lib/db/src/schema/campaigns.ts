import { pgTable, text, uuid, timestamp, integer, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

// "Activities" in the UI (Joint Campaigns / Events / Webinars) — a lightweight
// log, not marketing automation. Table name kept as `campaigns` to avoid a
// disruptive rename of the underlying entity.
export const campaignsTable = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type", { enum: ["joint_campaign", "event", "webinar"] }).notNull().default("joint_campaign"),
  territory: text("territory").notNull(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => usersTable.id),
  partnerCompanyId: uuid("partner_company_id").references(() => companiesTable.id, { onDelete: "set null" }),
  activityDate: date("activity_date", { mode: "string" }),
  status: text("status", { enum: ["planned", "live", "completed"] }).notNull().default("planned"),
  hubspotLink: text("hubspot_link"),
  mqls: integer("mqls").notNull().default(0),
  partnerReferrals: integer("partner_referrals").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({ id: true, createdAt: true });
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
