import { pgTable, text, uuid, timestamp, numeric, date, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";

export const kpiSnapshotsTable = pgTable("kpi_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  territoryId: uuid("territory_id"),
  metricName: text("metric_name").notNull(),
  currentValue: numeric("current_value").notNull(),
  targetValue: numeric("target_value"),
  lastWeekValue: numeric("last_week_value"),
  status: text("status", { enum: ["green", "amber", "red", "on_track"] }).notNull().default("amber"),
  explanation: text("explanation"),
  whatChanged: text("what_changed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Weekly-snapshot idempotency without a sentinel UUID for "Global": two
  // partial unique indexes split on whether territory_id is set, since a
  // plain UNIQUE(metric_name, territory_id, period_start) would let
  // Postgres treat every NULL territory_id as distinct and never enforce
  // uniqueness for Global rows.
  uniqueIndex("kpi_snapshots_territory_period_unique")
    .on(table.metricName, table.territoryId, table.periodStart)
    .where(sql`${table.territoryId} IS NOT NULL`),
  uniqueIndex("kpi_snapshots_global_period_unique")
    .on(table.metricName, table.periodStart)
    .where(sql`${table.territoryId} IS NULL`),
]);

export const insertKpiSnapshotSchema = createInsertSchema(kpiSnapshotsTable).omit({ id: true, createdAt: true });
export type InsertKpiSnapshot = z.infer<typeof insertKpiSnapshotSchema>;
export type KpiSnapshot = typeof kpiSnapshotsTable.$inferSelect;
