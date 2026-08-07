import { pgTable, text, uuid, boolean, timestamp, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { connectionsTable } from "./connections";

// Where each canonical KPI's value comes from. One row per metric_key.
// source_type drives how kpiService resolves the metric's current value:
//   PARTNER_RADAR / ACTIVITIES -> computed live from this app's own tables.
//   HUBSPOT                    -> computed from mapping_json against a connected HubSpot connection.
//   MANUAL                     -> looked up from manual_metric_values for the selected period/territory.
//   DEMO                       -> looked up from kpi_snapshots (seeded demo figures), labeled honestly.
//   NOT_CONNECTED              -> no value is shown ("--").
export const metricMappingsTable = pgTable("metric_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  metricKey: text("metric_key").notNull().unique(),
  sourceType: text("source_type", {
    enum: ["PARTNER_RADAR", "HUBSPOT", "ACTIVITIES", "MANUAL", "DEMO", "NOT_CONNECTED"],
  }).notNull(),
  connectionId: uuid("connection_id").references(() => connectionsTable.id, { onDelete: "set null" }),
  mappingJson: json("mapping_json").$type<Record<string, unknown> | null>(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMetricMappingSchema = createInsertSchema(metricMappingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMetricMapping = z.infer<typeof insertMetricMappingSchema>;
export type MetricMapping = typeof metricMappingsTable.$inferSelect;
