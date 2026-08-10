import { pgTable, text, uuid, timestamp, numeric, uniqueIndex } from "drizzle-orm/pg-core";
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
// period uses the same canonical period key as everywhere else in the KPI
// stack (kpiRegistry.PERIODS / resolvePeriodKey / manual_metric_values.period)
// -- q1/q2/q3/q4/ytd -- kept as unconstrained text, matching
// manual_metric_values.period exactly rather than introducing a new enum.
// Never assumes a specific year: PERIODS (kpiRegistry.ts) maps these keys
// to concrete dates for one year at a time -- that mapping, not this
// column, is what 6.3 will make dynamic.
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
    uniqueIndex("metric_targets_pam_territory_unique").on(table.metricKey, table.period, table.pamUserId, table.territoryId),
  ],
);

export const insertMetricTargetSchema = createInsertSchema(metricTargetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMetricTarget = z.infer<typeof insertMetricTargetSchema>;
export type MetricTarget = typeof metricTargetsTable.$inferSelect;
