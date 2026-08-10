import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { partnerRelationshipsTable, PARTNER_RELATIONSHIP_STATUSES } from "./partner_relationships";
import { usersTable } from "./users";
import { partnerRecruitmentsTable } from "./partner_recruitments";

// Append-only, event-based history for one partner_relationships row.
// Deliberately one small table (not a table per event type): every row
// shares the same nullable structured columns, only the ones relevant to
// event_type are populated.
export const RELATIONSHIP_HISTORY_EVENT_TYPES = [
  "created",
  "status_changed",
  "owner_changed",
  "reactivated",
  "closed",
  "recruitment_signed",
] as const;

export const partnerRelationshipHistoryTable = pgTable("partner_relationship_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  relationshipId: uuid("relationship_id").notNull().references(() => partnerRelationshipsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type", { enum: RELATIONSHIP_HISTORY_EVENT_TYPES }).notNull(),
  fromStatus: text("from_status", { enum: PARTNER_RELATIONSHIP_STATUSES }),
  toStatus: text("to_status", { enum: PARTNER_RELATIONSHIP_STATUSES }),
  fromUserId: uuid("from_user_id").references(() => usersTable.id),
  toUserId: uuid("to_user_id").references(() => usersTable.id),
  sourceRecruitmentId: uuid("source_recruitment_id").references(() => partnerRecruitmentsTable.id),
  // When the underlying business event actually happened, as reported by
  // the acting user -- may be backdated (e.g. logging today that a
  // relationship went dormant in May). NEVER interchangeable with
  // createdAt (when this row was written). Historical/period reporting
  // must use occurredAt.
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
  changedByUserId: uuid("changed_by_user_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPartnerRelationshipHistorySchema = createInsertSchema(partnerRelationshipHistoryTable).omit({ id: true, createdAt: true });
export type InsertPartnerRelationshipHistory = z.infer<typeof insertPartnerRelationshipHistorySchema>;
export type PartnerRelationshipHistory = typeof partnerRelationshipHistoryTable.$inferSelect;
