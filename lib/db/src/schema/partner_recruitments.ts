import { pgTable, text, uuid, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { prospectsTable } from "./prospects";
import { companiesTable } from "./companies";
import { territoriesTable } from "./territories";
import { usersTable } from "./users";

// The recruitment PROCESS for one accepted Discovery prospect -- not the
// future universal Partner Portfolio object. Deliberately a separate table
// from prospects (which already carries discovery-qualification fields and
// some legacy partner-operational fields): welding a 7-stage recruitment
// funnel onto that table would repeat the same overloading, and a company
// eventually originating from Portfolio Import or Manual Add (Stage 5+)
// won't have a Discovery prospect to hang recruitment fields off of.
// prospectId is unique -- at most one recruitment per prospect, enforced at
// the DB level so a repeated "Accept for Recruitment" can never fork state.
export const RECRUITMENT_STAGES = [
  "accepted",
  "contacting",
  "engaged",
  "agreement",
  "signed",
  "on_hold",
  "not_pursuing",
] as const;

export const NOT_PURSUING_REASONS = [
  "no_strategic_fit",
  "no_capacity",
  "competitor_conflict",
  "no_response",
  "geography_mismatch",
  "other",
] as const;

export const partnerRecruitmentsTable = pgTable("partner_recruitments", {
  id: uuid("id").primaryKey().defaultRandom(),
  prospectId: uuid("prospect_id").notNull().unique().references(() => prospectsTable.id, { onDelete: "cascade" }),
  // Denormalized from the prospect at handoff time (never re-derived on
  // every read) -- same convention as ai_channel_briefs/metric_targets.
  // No onDelete: matches the existing "no cascade on territory/user FKs"
  // convention already used throughout this schema.
  companyId: uuid("company_id").notNull().references(() => companiesTable.id),
  territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
  assignedUserId: uuid("assigned_user_id").references(() => usersTable.id),
  stage: text("stage", { enum: RECRUITMENT_STAGES }).notNull().default("accepted"),
  // Only ever meaningful while stage = on_hold (what to resume back into).
  previousStage: text("previous_stage", { enum: RECRUITMENT_STAGES }),
  notPursuingReason: text("not_pursuing_reason", { enum: NOT_PURSUING_REASONS }),
  nextStep: text("next_step"),
  followUpDate: date("follow_up_date", { mode: "string" }),
  // Reset on every stage change -- drives "days in stage" / stalled (> 14
  // days in an active stage) directly, no separate query needed.
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
  // Set only when entering "signed" -- the canonical Signed Partners KPI
  // date. Signed is treated as terminal in v1 (see partnerRecruitmentService.ts),
  // so this is never cleared once set.
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPartnerRecruitmentSchema = createInsertSchema(partnerRecruitmentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPartnerRecruitment = z.infer<typeof insertPartnerRecruitmentSchema>;
export type PartnerRecruitment = typeof partnerRecruitmentsTable.$inferSelect;
