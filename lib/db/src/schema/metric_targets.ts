import { pgTable, text, uuid, timestamp, numeric, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";
import { usersTable } from "./users";

// Management-configured KPI targets, deliberately separate from
// manual_metric_values (which bundles a required manual *current* value
// with an optional target -- computeMetric only ever reads that table when
// a metric's source_type is MANUAL, so it can't represent a target for a
// PARTNER_RADAR/ACTIVITIES/DEMO-sourced metric). A row here overrides the
// target for its metric_key/period/territory_id regardless of source_type,
// so editing a target never touches how "current" is computed. Absence of
// a row means "no target configured" -- never a fabricated default.
//
// Stage 6.3: period identity is year + quarterKey (q1/q2/q3/q4/ytd) as two
// separate columns -- the "year + period_key" model
// (kpiRegistry.splitPeriodKey/joinPeriodKey bridges this to the single
// composite "<year>-<quarterKey>" string used everywhere in memory/the
// API). Without `year`, "Q1 2026" and "Q1 2027" would collide on the same
// `period` value -- see drizzle/0012_*.sql for the year backfill (every
// pre-6.3 row is unambiguously 2026, the only year this app has ever run
// under).
//
// Stage 6.2: targets became explicitly PAM-scoped ("PAM is the person
// accountable, territory is reporting/context scope"). pam_user_id is
// nullable at the schema level only to preserve pre-6.2 rows that could not
// be safely backfilled (a Global row with no single owner, or a
// territory-scoped row whose territory had no canonical owner at migration
// time -- see drizzle/0011_*.sql) -- every row written through the API from
// 6.2 onward always has one. The one-PAM-owns-one-territory v1 invariant
// means (pam_user_id, territory_id) are validated as a matching canonical
// pair at write time (services/targetService.ts), never independently
// chosen.
export const metricTargetsTable = pgTable(
  "metric_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    metricKey: text("metric_key").notNull(),
    year: integer("year").notNull(),
    period: text("period").notNull(),
    territoryId: uuid("territory_id").references(() => territoriesTable.id, { onDelete: "cascade" }),
    pamUserId: uuid("pam_user_id").references(() => usersTable.id),
    targetValue: numeric("target_value").notNull(),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => usersTable.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one row per metric/period/PAM/territory. Rows with a NULL
    // pam_user_id and/or territory_id (orphaned pre-6.2 data, see above)
    // are never treated as duplicates of each other by Postgres -- which is
    // fine, since those rows are legacy/read-only, not something new writes
    // can ever produce (both columns are always populated together from
    // 6.2 onward).
    uniqueIndex("metric_targets_pam_territory_unique").on(table.metricKey, table.year, table.period, table.pamUserId, table.territoryId),
    // Phase 5A: the company-wide annual target (Irina/Head-level, period =
    // "annual", pam_user_id/territory_id both intentionally null) needs its
    // own explicit uniqueness -- the index above does NOT reliably enforce
    // "at most one" for these rows, because a plain (non-partial) unique
    // index treats every NULL as distinct from every other NULL in
    // Postgres, so two annual rows for the same metric_key+year would both
    // insert without conflict. A partial unique index over exactly the
    // annual-row shape closes that gap: only metric_key+year are indexed
    // (both NOT NULL, so no NULL-distinctness problem), scoped to rows that
    // are actually annual/global via the WHERE predicate.
    uniqueIndex("metric_targets_global_annual_unique")
      .on(table.metricKey, table.year)
      .where(sql`${table.pamUserId} is null and ${table.territoryId} is null and ${table.period} = 'annual'`),
  ],
);

export const insertMetricTargetSchema = createInsertSchema(metricTargetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMetricTarget = z.infer<typeof insertMetricTargetSchema>;
export type MetricTarget = typeof metricTargetsTable.$inferSelect;
