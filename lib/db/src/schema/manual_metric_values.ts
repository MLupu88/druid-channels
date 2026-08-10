import { pgTable, text, uuid, timestamp, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";

// Admin-entered figures for KPIs that aren't available from a live
// integration yet. Scoped by metric + reporting period + optional territory
// (null territory = Global). Always surfaced with data_status = MANUAL.
//
// Stage 6.3: `year` + `period` (quarterKey) together are the period
// identity -- see metric_targets.ts's header comment for why (Q1 2026 vs
// Q1 2027 must never collide). This table has no DB-level uniqueness
// constraint (upsert is matched application-side in
// routes/metric_mappings.ts, pre-dating the atomic-upsert convention used
// elsewhere) -- unchanged in 6.3, just extended to also match on year.
export const manualMetricValuesTable = pgTable("manual_metric_values", {
  id: uuid("id").primaryKey().defaultRandom(),
  metricKey: text("metric_key").notNull(),
  year: integer("year").notNull(),
  period: text("period").notNull(),
  territoryId: uuid("territory_id").references(() => territoriesTable.id, { onDelete: "cascade" }),
  currentValue: numeric("current_value").notNull(),
  targetValue: numeric("target_value"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertManualMetricValueSchema = createInsertSchema(manualMetricValuesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertManualMetricValue = z.infer<typeof insertManualMetricValueSchema>;
export type ManualMetricValue = typeof manualMetricValuesTable.$inferSelect;
