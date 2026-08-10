import { pgTable, text, uuid, timestamp, date, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { territoriesTable } from "./territories";
import { usersTable } from "./users";
import { partnerRecruitmentsTable } from "./partner_recruitments";

// Stage 6 Partner Portfolio: the canonical, persistent DRUID<->company
// relationship record. Deliberately NOT the same table as
// partner_recruitments (a recruitment is one funnel run; a relationship
// outlives it) and NOT a copy per PAM -- one dataset, scoped views.
//
// Canonical per (company, territory), not per company alone: the same
// company can have a separate, independently-owned relationship in each
// territory it's active in (e.g. Accenture Romania vs Accenture UK&I are
// two different relationships). Within one (company, territory) pair there
// is exactly one row, ever -- closing/reactivating is a status transition
// recorded in partner_relationship_history, never a new row.
export const PARTNER_RELATIONSHIP_STATUSES = ["active", "dormant", "closed"] as const;
export const RELATIONSHIP_STRATEGIC_IMPORTANCE = ["high", "medium", "low"] as const;
// How the relationship first entered the portfolio. This is ORIGIN only,
// not a complete history -- e.g. a pam_import relationship that later goes
// through a Signed recruitment does NOT get rewritten to "recruitment"; a
// partner_relationship_history row (event_type: recruitment_signed) records
// that instead. See partner_relationship_history.ts.
export const RELATIONSHIP_ORIGIN_TYPES = ["recruitment", "pam_import", "manual"] as const;
// Precision/provenance of relationship_started_at -- never fabricate a
// precise date from an imprecise source ("partner since Q1 2026" must not
// silently become "2026-01-01"). Reporting eligibility keys off precision
// (see kpiService's Stage 6 period logic): exact_date/month/quarter are
// usable for quarter/year rollups, year only for annual, unknown is
// excluded from "New Partners in period" entirely.
export const STARTED_AT_PRECISIONS = ["exact_date", "month", "quarter", "year", "unknown"] as const;
export const STARTED_AT_PROVENANCE = ["explicit", "inferred", "user_confirmed", "system_generated"] as const;

export const partnerRelationshipsTable = pgTable(
  "partner_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companiesTable.id),
    territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
    assignedUserId: uuid("assigned_user_id").references(() => usersTable.id),
    status: text("status", { enum: PARTNER_RELATIONSHIP_STATUSES }).notNull().default("active"),
    partnerType: text("partner_type"),
    strategicImportance: text("strategic_importance", { enum: RELATIONSHIP_STRATEGIC_IMPORTANCE }),
    relationshipSummary: text("relationship_summary"),
    relationshipStartedAt: date("relationship_started_at", { mode: "string" }),
    startedAtPrecision: text("started_at_precision", { enum: STARTED_AT_PRECISIONS }).notNull().default("unknown"),
    startedAtProvenance: text("started_at_provenance", { enum: STARTED_AT_PROVENANCE }),
    relationshipEndedAt: date("relationship_ended_at", { mode: "string" }),
    // Denormalized, recomputed whenever a partner_activities row is
    // inserted (never re-derived on every read) -- same convention as
    // partner_recruitments.stageEnteredAt.
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    nextAction: text("next_action"),
    nextActionDueAt: date("next_action_due_at", { mode: "string" }),
    originType: text("origin_type", { enum: RELATIONSHIP_ORIGIN_TYPES }).notNull(),
    originRecruitmentId: uuid("origin_recruitment_id").references(() => partnerRecruitmentsTable.id),
    // What the source claimed "as of" (e.g. an import spreadsheet's export
    // date) -- distinct from importedAt (when DRUID ingested it) and from
    // relationshipStartedAt (when the relationship itself began).
    sourceAsOfDate: date("source_as_of_date", { mode: "string" }),
    // Set only for origin_type = pam_import. Never conflated with
    // relationship_started_at for "New Partners in period" reporting.
    importedAt: timestamp("imported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("partner_relationships_company_territory_unique").on(table.companyId, table.territoryId)],
);

export const insertPartnerRelationshipSchema = createInsertSchema(partnerRelationshipsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPartnerRelationship = z.infer<typeof insertPartnerRelationshipSchema>;
export type PartnerRelationship = typeof partnerRelationshipsTable.$inferSelect;
