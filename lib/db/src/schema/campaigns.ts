import { pgTable, text, uuid, timestamp, integer, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const campaignsTable = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  territory: text("territory").notNull(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => usersTable.id),
  segment: text("segment").notNull(),
  prospectCount: integer("prospect_count").notNull().default(0),
  messageAngle: text("message_angle").notNull(),
  startDate: date("start_date", { mode: "string" }),
  status: text("status", { enum: ["planned", "active", "completed"] }).notNull().default("planned"),
  replies: integer("replies").notNull().default(0),
  qualifiedMeetings: integer("qualified_meetings").notNull().default(0),
  signedPartners: integer("signed_partners").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({ id: true, createdAt: true });
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
