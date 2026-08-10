import { pgTable, uuid, boolean, json, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";

// Stage 5 Channel Radar: what to monitor per territory. One config per
// territory (territoryId unique), same cardinality convention as
// scan_configs -- an admin creates it once, then edits it in place.
export const channelRadarConfigsTable = pgTable("channel_radar_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  territoryId: uuid("territory_id").notNull().unique().references(() => territoriesTable.id),
  active: boolean("active").notNull().default(true),
  // Company/entity names to monitor (competitors, partners, ecosystem
  // players) -- e.g. "Microsoft", "UiPath". Free text, admin-curated.
  monitoredEntities: json("monitored_entities").$type<string[]>().notNull().default([]),
  // Subset of RADAR_SIGNAL_TYPES (channel_radar_signals.ts) this territory
  // wants surfaced. Empty means no signal-type-specific query phrasing --
  // the engine falls back to a generic per-entity query.
  enabledSignalTypes: json("enabled_signal_types").$type<string[]>().notNull().default([]),
  lookbackDays: integer("lookback_days").notNull().default(30),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertChannelRadarConfigSchema = createInsertSchema(channelRadarConfigsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertChannelRadarConfig = z.infer<typeof insertChannelRadarConfigSchema>;
export type ChannelRadarConfig = typeof channelRadarConfigsTable.$inferSelect;
