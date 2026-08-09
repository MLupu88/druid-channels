import { pgTable, text, uuid, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { territoriesTable } from "./territories";
import { usersTable } from "./users";

// Content shape produced by aiBriefProvider.generate() and validated by
// aiChannelBriefService before ever reaching this table -- see
// services/aiBriefProvider.ts for the canonical types.
export interface AiBriefEvidenceItem {
  text: string;
  supporting_metrics: string[];
}
export interface AiChannelBriefContent {
  executive_summary: string;
  key_highlights: AiBriefEvidenceItem[];
  risks: AiBriefEvidenceItem[];
  opportunities: AiBriefEvidenceItem[];
  recommended_actions: AiBriefEvidenceItem[];
}

// A row only ever exists if a generation succeeded -- there is deliberately
// no status/error_message column. A failed regeneration never writes here,
// so the previous good brief (if any) can never be overwritten by a
// failure; GET derives "stale" by comparing snapshot_hash instead of
// trusting a persisted status flag.
//
// snapshot_hash is the *generation-input* hash: period + exact territory
// scope + currency + the sorted/normalized evidence-eligible (CONNECTED or
// MANUAL only) metrics -- never DEMO/NOT_CONNECTED ones. A DEMO value or
// timestamp changing must never make a real, evidence-backed brief look
// stale; a metric crossing the CONNECTED/MANUAL <-> DEMO/NOT_CONNECTED
// boundary does change the hash, since it enters or leaves the eligible set.
export const aiChannelBriefsTable = pgTable(
  "ai_channel_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    period: text("period").notNull(), // canonical q1/q2/q3/q4/ytd key, same convention as metric_targets/kpiRegistry
    territoryId: uuid("territory_id").references(() => territoriesTable.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(), // part of the cache scope -- a USD brief and an EUR brief are different generations
    content: jsonb("content").$type<AiChannelBriefContent>().notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    dataAsOf: timestamp("data_as_of", { withTimezone: true }), // nullable: derived only from eligible metrics' last_updated, never substituted with generated_at
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    // Audit-only -- never returned by GET. No onDelete clause, matching
    // every other audit-style user FK in this schema (campaigns.owner_user_id,
    // prospect_activity.actor_user_id, metric_targets.updated_by_user_id,
    // prospects.assigned_user_id): this app has no user hard-deletion
    // capability (users.ts only supports deactivation), so none of those
    // FKs use ON DELETE SET NULL, and introducing it only here would be a
    // new, inconsistent pattern for a problem this codebase doesn't have.
    requestedByUserId: uuid("requested_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Territory-specific: at most one row per period/territory/currency.
    uniqueIndex("ai_channel_briefs_territory_unique").on(table.period, table.territoryId, table.currency),
    // Global: at most one row per period/currency where territory_id IS NULL.
    uniqueIndex("ai_channel_briefs_global_unique")
      .on(table.period, table.currency)
      .where(sql`${table.territoryId} is null`),
  ],
);

export const insertAiChannelBriefSchema = createInsertSchema(aiChannelBriefsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiChannelBrief = z.infer<typeof insertAiChannelBriefSchema>;
export type AiChannelBrief = typeof aiChannelBriefsTable.$inferSelect;
