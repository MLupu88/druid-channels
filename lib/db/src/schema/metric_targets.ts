import { pgTable, text, uuid, timestamp, numeric, uniqueIndex } from "drizzle-orm/pg-core";
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
// period uses the same canonical period key as everywhere else in the KPI
// stack (kpiRegistry.PERIODS / resolvePeriodKey / manual_metric_values.period)
// -- q1/q2/q3/q4/ytd -- kept as unconstrained text, matching
// manual_metric_values.period exactly rather than introducing a new enum.
export const metricTargetsTable = pgTable(
  "metric_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    metricKey: text("metric_key").notNull(),
    period: text("period").notNull(),
    territoryId: uuid("territory_id").references(() => territoriesTable.id, { onDelete: "cascade" }),
    targetValue: numeric("target_value").notNull(),
    note: text("note"),
    updatedByUserId: uuid("updated_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Territory-specific: at most one row per metric/period/territory.
    // (Postgres unique indexes never treat a row with a NULL indexed column
    // as a duplicate of another, so this alone does not constrain the
    // territory_id IS NULL / global case -- that's the second index below.)
    uniqueIndex("metric_targets_territory_unique").on(table.metricKey, table.period, table.territoryId),
    // Global: at most one row per metric/period where territory_id IS NULL.
    uniqueIndex("metric_targets_global_unique")
      .on(table.metricKey, table.period)
      .where(sql`${table.territoryId} is null`),
  ],
);

export const insertMetricTargetSchema = createInsertSchema(metricTargetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMetricTarget = z.infer<typeof insertMetricTargetSchema>;
export type MetricTarget = typeof metricTargetsTable.$inferSelect;
