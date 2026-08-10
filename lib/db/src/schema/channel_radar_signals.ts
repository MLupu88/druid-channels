import { pgTable, text, uuid, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

// Stage 5 Channel Radar: regional competitive/ecosystem intelligence.
// Deliberately a separate model from prospects/partner_recruitments/
// companies/signals -- a Radar signal is about the broader market (a
// competitor, an ecosystem player, a partner's OWN move), not a candidate
// DRUID is evaluating for recruitment. The same company can legitimately
// appear in both Discovery and Radar for entirely different reasons.

export const RADAR_ENTITY_TYPES = ["competitor", "partner", "ecosystem", "other"] as const;

export const RADAR_SIGNAL_TYPES = [
  "acquisition",
  "partnership",
  "reseller_distributor",
  "regional_expansion",
  "leadership_hire",
  "funding",
  "customer_win",
  "product_gtm",
  "marketplace_listing",
  "event",
  "other",
] as const;

export const RADAR_IMPLICATIONS = ["opportunity", "threat", "neutral"] as const;
export const RADAR_IMPACTS = ["high", "medium", "low"] as const;
export const RADAR_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const RADAR_SIGNAL_STATUSES = ["new", "reviewed", "dismissed"] as const;

export const channelRadarSignalsTable = pgTable("channel_radar_signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  territoryId: uuid("territory_id").notNull().references(() => territoriesTable.id),
  assignedUserId: uuid("assigned_user_id").references(() => usersTable.id),
  // Nullable, structural only -- no automatic resolution logic yet. A
  // future pass may link a Radar signal to the canonical companies row it
  // concerns (e.g. once entity-identity resolution, mirroring Discovery's
  // Stage 3 completion pattern, is built for Radar). Never set today.
  companyId: uuid("company_id").references(() => companiesTable.id),
  entityName: text("entity_name").notNull(),
  entityType: text("entity_type", { enum: RADAR_ENTITY_TYPES }).notNull(),
  signalType: text("signal_type", { enum: RADAR_SIGNAL_TYPES }).notNull(),
  headline: text("headline").notNull(),
  summary: text("summary").notNull(),
  whyItMatters: text("why_it_matters").notNull(),
  implication: text("implication", { enum: RADAR_IMPLICATIONS }).notNull(),
  impact: text("impact", { enum: RADAR_IMPACTS }).notNull(),
  recommendedAction: text("recommended_action").notNull(),
  confidence: text("confidence", { enum: RADAR_CONFIDENCE_LEVELS }).notNull(),
  sourceTitle: text("source_title").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceDomain: text("source_domain"),
  // Nullable, never fabricated -- Tavily's search response carries no
  // per-result publish date (same honesty convention established for
  // Discovery's signals.published_at).
  sourcePublishedAt: date("source_published_at", { mode: "string" }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  // Deterministic, event-based (entity + signal_type + normalized source
  // URL) -- never a timestamp. Unique so a repeated "Run Radar" collapses
  // onto the same row via ON CONFLICT DO NOTHING instead of duplicating.
  dedupeKey: text("dedupe_key").notNull().unique(),
  status: text("status", { enum: RADAR_SIGNAL_STATUSES }).notNull().default("new"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertChannelRadarSignalSchema = createInsertSchema(channelRadarSignalsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertChannelRadarSignal = z.infer<typeof insertChannelRadarSignalSchema>;
export type ChannelRadarSignal = typeof channelRadarSignalsTable.$inferSelect;
