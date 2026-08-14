import { pgTable, text, uuid, timestamp, date, jsonb, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import type { WeeklyMetricsSnapshot } from "../reporting/weeklyPamReportContract";

// Phase 7: one row per (PAM, reporting week) -- report metadata and
// PAM-authored commentary only. Deliberately does NOT persist a copy of
// every calculated metric on every read: a draft/current-week report is
// always computed live from the same canonical services Overview/Team
// Targets/Marketing Activities already use
// (services/weeklyReportingService.ts), never a second KPI engine.
//
// metrics_snapshot/snapshot_generated_at exist purely for the freeze-on-
// submit exception: once a PAM submits, the live figures at that moment are
// computed once and frozen here so a historical submitted report reads back
// exactly what was true when submitted, rather than silently drifting if
// the underlying commercial/recruitment/marketing data changes later. A
// draft row's metrics_snapshot is always null -- never read for a
// not-yet-submitted report. Submitted is immutable in Phase 7 v1: neither
// the snapshot nor the commentary fields below can be edited again after
// status becomes "submitted" (see services/weeklyReportingService.ts) --
// no reopen/version workflow exists yet.
export const WEEKLY_PAM_REPORT_STATUSES = ["draft", "submitted"] as const;

export const weeklyPamReportsTable = pgTable(
  "weekly_pam_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pamUserId: uuid("pam_user_id").notNull().references(() => usersTable.id),
    // Captured at report time (never re-derived from current territory
    // ownership) so a later territory reassignment does not silently
    // rewrite which territories a historical report is attributed to. A
    // JSON array, not a single FK: territories.owner_user_id has no DB
    // uniqueness constraint, so a PAM may canonically own more than one
    // territory (see authz.getOwnTerritories) -- matches the existing
    // no-FK-on-array-elements convention already used by
    // territories.countries/languages, just via jsonb (this codebase's
    // generally-preferred JSON column type, see ai_channel_briefs.content)
    // rather than plain json.
    territoryIds: jsonb("territory_ids").$type<string[]>().notNull(),
    // Monday (UTC, YYYY-MM-DD) of the reporting week -- same week-alignment
    // convention as kpiService.mondayOf/kpi_snapshots.period_start. Always
    // a canonical Monday; validated at the service/API input layer
    // (services/weeklyReportingService.ts), never enforced as a DB CHECK
    // (would require server-side weekday arithmetic in a constraint).
    weekStartDate: date("week_start_date", { mode: "string" }).notNull(),
    status: text("status", { enum: WEEKLY_PAM_REPORT_STATUSES }).notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    // Null until the PAM submits. See WeeklyMetricsSnapshot
    // (../reporting/weeklyPamReportContract.ts) for the shape -- that module
    // owns this contract, not this schema file.
    metricsSnapshot: jsonb("metrics_snapshot").$type<WeeklyMetricsSnapshot>(),
    snapshotGeneratedAt: timestamp("snapshot_generated_at", { withTimezone: true }),
    winsProgress: text("wins_progress"),
    risksBlockers: text("risks_blockers"),
    prioritiesNextWeek: text("priorities_next_week"),
    helpNeeded: text("help_needed"),
    commentaryUpdatedAt: timestamp("commentary_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Deterministic weekly report identity: at most one report per PAM per
    // reporting week, ever.
    uniqueIndex("weekly_pam_reports_pam_week_unique").on(table.pamUserId, table.weekStartDate),
    // The one invariant worth enforcing at the DB level: a submitted report
    // can never exist without its frozen snapshot metadata. Deliberately no
    // corresponding draft-side constraint (e.g. forbidding a draft from
    // having a snapshot) -- there is no such invariant to enforce, and this
    // stays a single, narrow CHECK rather than a general-purpose state
    // machine.
    check(
      "weekly_pam_reports_submitted_requires_snapshot",
      sql`${table.status} <> 'submitted' or (${table.metricsSnapshot} is not null and ${table.snapshotGeneratedAt} is not null and ${table.submittedAt} is not null)`,
    ),
  ],
);

export const insertWeeklyPamReportSchema = createInsertSchema(weeklyPamReportsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWeeklyPamReport = z.infer<typeof insertWeeklyPamReportSchema>;
export type WeeklyPamReport = typeof weeklyPamReportsTable.$inferSelect;
