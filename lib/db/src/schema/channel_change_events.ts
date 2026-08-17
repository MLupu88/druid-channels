import { pgTable, text, uuid, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Aniri / Channel Chief evidence infrastructure: a small, append-only log of
// material business mutations that do NOT already have a canonical history
// mechanism. Deliberately narrow -- this is NOT a generic enterprise audit
// framework and NOT a second history table for entities that already have
// one:
//   - partner_recruitments has partner_recruitment_history (stage changes)
//   - partner_relationships has partner_relationship_history (status/owner/
//     lifecycle events)
// Neither of those is mirrored here (see channelChangeFeedService.ts's
// normalization layer, which reads all three sources and merges them into
// one read-only feed WITHOUT duplicating storage). This table exists only
// for the two entities that currently have no append-only history at all:
// metric_targets (create/update/delete) and partner_opportunities
// (create/material-field PATCH).
export const CHANNEL_CHANGE_ENTITY_TYPES = ["metric_target", "opportunity"] as const;
export const CHANNEL_CHANGE_EVENT_TYPES = ["created", "updated", "deleted"] as const;

export const channelChangeEventsTable = pgTable(
  "channel_change_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type", { enum: CHANNEL_CHANGE_ENTITY_TYPES }).notNull(),
    // Deliberately NOT a foreign key: entity_type disambiguates which table
    // this conceptually points to (metric_targets vs partner_opportunities),
    // and a single FK column cannot reference two different tables. Just as
    // important, a "deleted" event must survive after its source row is
    // gone -- an onDelete-cascaded FK would destroy the exact evidence this
    // table exists to keep.
    entityId: uuid("entity_id").notNull(),
    eventType: text("event_type", { enum: CHANNEL_CHANGE_EVENT_TYPES }).notNull(),
    // Nullable to match partner_recruitment_history.changed_by_user_id's
    // existing convention, but every write path here always populates it
    // from req.actingUser (requireAuth/requireAdmin guarantees one) -- null
    // is not expected in practice, just not schema-enforced, matching
    // precedent. No cascade: an audit row must never disappear because of
    // something that later happens to the acting user's account.
    actorUserId: uuid("actor_user_id").references(() => usersTable.id),
    // The business mutation time (when the write actually happened) --
    // always defaultNow() here, since unlike partner_relationship_history's
    // occurred_at (which a human can backdate to describe when something
    // happened in the real world), there is no backdating concept for a
    // target/opportunity field edit: the mutation IS the event. Kept as its
    // own explicit column (not reused as createdAt) purely for read-model
    // uniformity with the other two history sources, which both expose a
    // distinct business-event timestamp -- see
    // channelChangeFeedService.ts's normalization comment.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Null on a "created" event (there is no prior state). Only the fields
    // that actually changed are ever present here -- never a full snapshot
    // of every column, and never a no-op diff (see the callers in
    // targetService.ts/routes/opportunities.ts for the "no meaningful
    // change -> no event" guard).
    oldValues: jsonb("old_values").$type<Record<string, unknown>>(),
    // Null on a "deleted" event (there is no resulting state).
    newValues: jsonb("new_values").$type<Record<string, unknown>>(),
    // Optional, small, identity/display context that does NOT itself
    // change as part of this event (e.g. a target's metric_key/year/period,
    // an opportunity's name/company_id) -- kept separate from old_values/
    // new_values so those two stay a strict "what changed" diff, never
    // padded with unchanged context to make a notification easier to write.
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [index("channel_change_events_occurred_at_idx").on(table.occurredAt), index("channel_change_events_entity_idx").on(table.entityType, table.entityId)],
);

export const insertChannelChangeEventSchema = createInsertSchema(channelChangeEventsTable).omit({ id: true, createdAt: true });
export type InsertChannelChangeEvent = z.infer<typeof insertChannelChangeEventSchema>;
export type ChannelChangeEvent = typeof channelChangeEventsTable.$inferSelect;
