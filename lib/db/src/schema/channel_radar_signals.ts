import { pgTable, text, uuid, timestamp, date, boolean, uniqueIndex } from "drizzle-orm/pg-core";
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

export const RADAR_ENTITY_TYPES = ["competitor", "partner", "ecosystem", "technology_vendor", "other"] as const;

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
  "partner_program",
  "tender_rfp",
  "other",
] as const;

// Phase 10: "watch" is strategically relevant but not yet enough evidence/
// urgency to call opportunity or threat -- distinct from confidence (an
// orthogonal axis: evidence quality, not directional read).
export const RADAR_IMPLICATIONS = ["opportunity", "threat", "watch", "neutral"] as const;
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
  // Phase 10: relevant DRUID partner motion/capability, kept separate from
  // recommended_action (a specific next step) -- never conflated.
  druidPartnerMotion: text("druid_partner_motion"),
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
  // URL) -- never a timestamp. A repeated "Run Radar" collapses onto the
  // same row via ON CONFLICT DO NOTHING instead of duplicating. Still the
  // cheap floor check for an exact-URL repeat; cross-run consolidation onto
  // a DIFFERENT url for the SAME event is handled by the candidate-search +
  // bounded same-event AI check in channelRadarEngine.ts, not by this key
  // (see channel_radar_signal_evidence.ts).
  //
  // Phase 10 fix: uniqueness on this column is deliberately NOT global (see
  // the composite index below) -- the same entity+signal_type+URL is a
  // legitimate, independent event in a different territory (e.g. a global
  // vendor's announcement picked up by two territories' scans) and must be
  // able to create/own its own signal there, not be silently suppressed by
  // an unrelated territory's row sharing the same content hash.
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status", { enum: RADAR_SIGNAL_STATUSES }).notNull().default("new"),
  // Phase 10: computed at write time from independent factors (ambiguous
  // entity/counterparty identity, uncertain regional applicability, low
  // confidence) -- deliberately never defined as simply confidence=='low'.
  // See channelRadarEngine.ts's computeRequiresValidation.
  requiresValidation: boolean("requires_validation").notNull().default(false),
  // Phase 10: the AI's own explicit commitment to whether the evidence text
  // itself (not just the search query's geo term) grounds the territory
  // claim. Nullable -- unset for pre-Phase-10 rows.
  regionalApplicabilityCertain: boolean("regional_applicability_certain"),
  // Phase 10: lightweight relationship mapping -- the event's counterparty,
  // when it has one (e.g. the partner a competitor signed). Free text,
  // never fabricated; bridged to companies via the same exact/ambiguity-safe
  // logic as entityName/companyId (see radarCompanyBridge.ts), staying null
  // on any ambiguity or when no canonical company exists.
  relatedEntityName: text("related_entity_name"),
  relatedEntityType: text("related_entity_type", { enum: RADAR_ENTITY_TYPES }),
  relatedEntityCompanyId: uuid("related_entity_company_id").references(() => companiesTable.id),
  // Short, evidence-grounded descriptor of the relationship to
  // related_entity_name (e.g. "reseller", "acquirer of") -- deliberately
  // free text, not a second taxonomy: signal_type already carries the
  // categorical shape.
  relationshipLabel: text("relationship_label"),
  // Phase 10: initialized from the signal's own discoveredAt at creation
  // time (see channelRadarEngine.ts), then bumped -- and ONLY bumped, never
  // reset -- whenever corroborating evidence attaches via the cross-run
  // same-event match. Never implies the classification changed. Nullable
  // only because pre-Phase-10 rows never had it set; readers fall back to
  // discoveredAt for those.
  lastEvidenceAt: timestamp("last_evidence_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Phase 10 fix: uniqueness is TERRITORY-scoped, not global -- replaces the
  // old single-column UNIQUE(dedupe_key). See the dedupeKey column comment
  // above for why. runRadarForConfig's onConflictDoNothing target and its
  // pre-insert floor checks (channelRadarEngine.ts) both key off this exact
  // composite.
  uniqueIndex("channel_radar_signals_territory_dedupe_key_unique").on(table.territoryId, table.dedupeKey),
]);

export const insertChannelRadarSignalSchema = createInsertSchema(channelRadarSignalsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertChannelRadarSignal = z.infer<typeof insertChannelRadarSignalSchema>;
export type ChannelRadarSignal = typeof channelRadarSignalsTable.$inferSelect;
