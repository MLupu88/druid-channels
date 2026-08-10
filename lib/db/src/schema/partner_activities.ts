import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { partnerRelationshipsTable } from "./partner_relationships";
import { usersTable } from "./users";

// Dated interactions logged against a partner_relationships row. Separate
// from partner_relationship_history (structured lifecycle/ownership
// events) -- this is a free-form-but-typed activity log, closer to
// prospect_activity in spirit but with a mandatory occurredAt distinct
// from createdAt (a PAM may log a meeting after the fact).
export const PARTNER_ACTIVITY_TYPES = [
  "meeting",
  "call",
  "review",
  "partner_update",
  "opportunity_discussion",
  "next_action",
  "other",
] as const;

export const partnerActivitiesTable = pgTable("partner_activities", {
  id: uuid("id").primaryKey().defaultRandom(),
  relationshipId: uuid("relationship_id").notNull().references(() => partnerRelationshipsTable.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id),
  activityType: text("activity_type", { enum: PARTNER_ACTIVITY_TYPES }).notNull(),
  note: text("note").notNull(),
  // When the interaction actually happened -- never assumed to equal
  // createdAt. Drives "latest activity"/relationship-age reporting.
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPartnerActivitySchema = createInsertSchema(partnerActivitiesTable).omit({ id: true, createdAt: true });
export type InsertPartnerActivity = z.infer<typeof insertPartnerActivitySchema>;
export type PartnerActivity = typeof partnerActivitiesTable.$inferSelect;
