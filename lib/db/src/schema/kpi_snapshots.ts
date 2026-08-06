import { pgTable, text, uuid, timestamp, numeric, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const kpiSnapshotsTable = pgTable("kpi_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  territoryId: uuid("territory_id"),
  metricName: text("metric_name").notNull(),
  currentValue: numeric("current_value").notNull(),
  targetValue: numeric("target_value").notNull(),
  lastWeekValue: numeric("last_week_value"),
  status: text("status", { enum: ["green", "amber", "red", "on_track"] }).notNull().default("amber"),
  explanation: text("explanation"),
  whatChanged: text("what_changed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertKpiSnapshotSchema = createInsertSchema(kpiSnapshotsTable).omit({ id: true, createdAt: true });
export type InsertKpiSnapshot = z.infer<typeof insertKpiSnapshotSchema>;
export type KpiSnapshot = typeof kpiSnapshotsTable.$inferSelect;
