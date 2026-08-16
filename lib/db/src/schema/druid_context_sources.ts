import { pgTable, text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Phase 11.5C.2: one row per extracted VERSION of an authoritative
// druidai.com page -- source EVIDENCE, never itself a DRUID fact. A single
// page can support multiple independent druid_facts (see druid_facts.ts's
// sourceContextId), so facts and their source material are deliberately
// separate tables -- extracted website content must never be mistaken for
// (or silently promoted into) a trusted fact. reviewStatus tracks whether a
// human has looked at this source version; it is completely independent of
// any druid_facts.verificationStatus -- reviewing a source, or creating a
// fact from it, never verifies anything (see services/druidFacts.ts's
// verifyDruidFact, the only function that ever sets verification_status =
// "verified").
export const DRUID_CONTEXT_SOURCE_REVIEW_STATUSES = ["pending_review", "reviewed", "ignored"] as const;

export const druidContextSourcesTable = pgTable(
  "druid_context_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The real, original URL as returned by Tavily -- kept verbatim for
    // display/provenance, and copied verbatim onto any druid_facts row
    // created from this source (see druidFacts.ts's createIngestedDruidFact).
    sourceUrl: text("source_url").notNull(),
    // Normalized form (services/druidContextSources.ts's normalizeUrl), used
    // only as half of the dedup/versioning key below -- never displayed,
    // same convention as channel_radar_signal_evidence.normalizedUrl.
    normalizedUrl: text("normalized_url").notNull(),
    // SHA-256 hex digest over the FINAL, already-bounded extractedText
    // (never the raw/unbounded provider response) -- see
    // services/druidContextSources.ts's computeContentHash.
    contentHash: text("content_hash").notNull(),
    extractedText: text("extracted_text").notNull(),
    // pending_review -> reviewed | ignored, both terminal (see
    // services/druidContextSources.ts's markSourceReviewed/markSourceIgnored).
    // "ignored" means this particular content VERSION is intentionally
    // excluded from use -- a later refresh that finds changed content at the
    // same normalized_url creates a brand-new pending_review row (different
    // content_hash), never resurrects this one.
    reviewStatus: text("review_status", { enum: DRUID_CONTEXT_SOURCE_REVIEW_STATUSES }).notNull().default("pending_review"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
    // Bumped (not treated as a new row) whenever a refresh re-encounters the
    // exact same (normalized_url, content_hash) pair -- see
    // services/druidContextSources.ts's refreshDruidContextSources.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    // The dedup/versioning floor: the same page content is recorded at most
    // once. A refresh with unchanged content matches this and only bumps
    // lastSeenAt; changed content at the same URL has a different hash and
    // therefore inserts a new row (a new version), leaving the old one
    // untouched -- same composite-unique-index shape as
    // channel_radar_signal_evidence's (signal_id, normalized_url).
    uniqueIndex("druid_context_sources_normalized_url_content_hash_unique").on(table.normalizedUrl, table.contentHash),
  ],
);

export const insertDruidContextSourceSchema = createInsertSchema(druidContextSourcesTable).omit({ id: true, extractedAt: true });
export type InsertDruidContextSource = z.infer<typeof insertDruidContextSourceSchema>;
export type DruidContextSource = typeof druidContextSourcesTable.$inferSelect;
