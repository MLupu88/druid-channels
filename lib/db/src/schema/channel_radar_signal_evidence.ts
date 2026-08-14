import { pgTable, text, uuid, timestamp, date, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { channelRadarSignalsTable } from "./channel_radar_signals";

// Phase 10: complete evidence provenance for a Channel Radar signal (the
// "event"). One signal can have many evidence rows -- the primary source is
// mirrored here at signal creation (is_primary = true), and any later
// corroborating source found via the cross-run same-event match
// (channelRadarEngine.ts) is attached here too (is_primary = false). This
// table is the single source of truth for "which URLs have been recorded
// against this event" -- both for idempotent within-signal dedup (the
// unique index below) and for the UI's evidence list. signals.source_* stays
// a denormalized cache of the primary row for cheap list-view reads, the
// same convention already used for partner_relationships.lastInteractionAt.
export const channelRadarSignalEvidenceTable = pgTable(
  "channel_radar_signal_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id").notNull().references(() => channelRadarSignalsTable.id, { onDelete: "cascade" }),
    sourceTitle: text("source_title").notNull(),
    // The real, original URL -- kept verbatim for display/traceability.
    sourceUrl: text("source_url").notNull(),
    // Normalized form (see channelRadarEngine.ts's normalizeUrl), used only
    // as the uniqueness key -- never displayed. Lets a re-crawl of the same
    // story under a trailing-slash/www/protocol variant still collapse.
    normalizedUrl: text("normalized_url").notNull(),
    sourceDomain: text("source_domain"),
    // Nullable, never fabricated -- same honesty convention as
    // signals.sourcePublishedAt.
    sourcePublishedAt: date("source_published_at", { mode: "string" }),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (table) => [
    // Source identity floor: a given URL is recorded at most once per
    // signal, regardless of how many runs or candidate-match passes
    // encounter it again.
    uniqueIndex("channel_radar_signal_evidence_signal_url_unique").on(table.signalId, table.normalizedUrl),
  ],
);

export const insertChannelRadarSignalEvidenceSchema = createInsertSchema(channelRadarSignalEvidenceTable).omit({ id: true, discoveredAt: true });
export type InsertChannelRadarSignalEvidence = z.infer<typeof insertChannelRadarSignalEvidenceSchema>;
export type ChannelRadarSignalEvidence = typeof channelRadarSignalEvidenceTable.$inferSelect;
