import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { partnerRecruitmentsTable, RECRUITMENT_STAGES } from "./partner_recruitments";
import { usersTable } from "./users";

// Append-only stage-change log for one recruitment -- deliberately not a
// generic activity/task framework (matches prospect_activity's own scope:
// one narrow event type, not a free-form CRM timeline).
export const partnerRecruitmentHistoryTable = pgTable("partner_recruitment_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  recruitmentId: uuid("recruitment_id").notNull().references(() => partnerRecruitmentsTable.id, { onDelete: "cascade" }),
  fromStage: text("from_stage", { enum: RECRUITMENT_STAGES }), // null on the initial "accepted" row
  toStage: text("to_stage", { enum: RECRUITMENT_STAGES }).notNull(),
  note: text("note"),
  // Nullable to match prospect_activity.actor_user_id's existing
  // convention, but every route that inserts a row here always populates
  // it from req.actingUser (requireAuth guarantees one) -- null is not
  // expected in practice, just not schema-enforced, matching precedent.
  changedByUserId: uuid("changed_by_user_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPartnerRecruitmentHistorySchema = createInsertSchema(partnerRecruitmentHistoryTable).omit({ id: true, createdAt: true });
export type InsertPartnerRecruitmentHistory = z.infer<typeof insertPartnerRecruitmentHistorySchema>;
export type PartnerRecruitmentHistory = typeof partnerRecruitmentHistoryTable.$inferSelect;
