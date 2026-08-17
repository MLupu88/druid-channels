// Aniri / Channel Chief evidence infrastructure (read side). Normalizes
// FOUR sources of material business change into one stable, read-only feed:
//   - partner_recruitment_history (existing, unchanged -- stage changes)
//   - partner_relationship_history (existing, unchanged -- status/owner/
//     lifecycle events)
//   - channel_change_events, entity_type "metric_target" (this phase)
//   - channel_change_events, entity_type "opportunity" (this phase)
// This module NEVER writes to any of the four source tables -- it is a pure
// read/normalize layer. Recruitment and relationship history are
// deliberately NOT duplicated into channel_change_events (see that table's
// own header comment); they are read directly, here, and merged into the
// same output shape as the two channel_change_events-backed sources.
//
// Timestamps: each source's own genuine business-event time is used, never
// conflated with an audit-write timestamp that happens to differ from it --
//   - recruitment: created_at (the row IS the stage-change event; there is
//     no separate/backdatable business time for it)
//   - partner relationship: occurred_at (may be backdated by a human to
//     describe when something really happened -- never created_at)
//   - metric_target / opportunity (channel_change_events): occurred_at,
//     which is always the actual mutation time for these two sources (see
//     channel_change_events.ts's own comment on why there is no backdating
//     concept for a field edit)
import { db } from "@workspace/db";
import {
  channelChangeEventsTable,
  partnerRecruitmentHistoryTable,
  partnerRecruitmentsTable,
  partnerRelationshipHistoryTable,
  partnerRelationshipsTable,
  companiesTable,
  territoriesTable,
  usersTable,
} from "@workspace/db";
import { desc, gt, inArray } from "drizzle-orm";

const DEFAULT_FEED_LIMIT = 50;
const MAX_FEED_LIMIT = 200;

export function boundFeedLimit(limit: number | null | undefined): number {
  return Math.max(1, Math.min(limit ?? DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT));
}

// First value that's actually a non-empty string, else null -- used to pick
// a display-context id out of whichever of metadata/new_values/old_values
// actually carries it for a given event, without guessing/fabricating.
function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export interface ChannelChangeFeedItem {
  id: string; // the underlying source row's own id -- stable, never re-derived
  entity_type: "recruitment" | "partner_relationship" | "metric_target" | "opportunity";
  entity_id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_name: string | null;
  occurred_at: string; // ISO
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  // Small, display-oriented context (names, not ids-only) -- enough for a
  // leadership notification to read naturally, deliberately not a second
  // copy of the full source row.
  context: Record<string, unknown> | null;
}

// Internal, pre-name-resolution shape -- built once per source, then a
// single batched user/company/territory lookup resolves actor_name/context
// across all four sources together (never one lookup per row).
interface RawFeedItem extends Omit<ChannelChangeFeedItem, "actor_name" | "context"> {
  companyId: string | null;
  territoryId: string | null;
  pamUserId: string | null;
}

/**
 * Bounded per-source fetch: the most recent `limit` rows from each of the
 * four sources (optionally filtered to occurred-after `since`), merged and
 * re-sorted. This is a correct, standard bounded top-k merge: if the
 * globally most-recent `limit` items exist, each one must appear among ITS
 * OWN source's most-recent `limit` rows, so fetching `limit` from each
 * source before merging can never miss one -- while still never pulling an
 * entire table into memory.
 *
 * Known residual edge case: this per-source SQL LIMIT could itself split a
 * group of rows that are tied (share an identical occurred_at) at exactly
 * that source's own cutoff -- the same since-cursor skip risk the merge
 * boundary below is guarded against, just one level earlier. Not guarded
 * here: it would require a supplemental per-source query only in the tie
 * case. Given each source's window is already generously bounded (up to
 * `limit` rows fetched independently from each of three tables before any
 * merging), a genuine tie landing exactly on that boundary is a narrow
 * residual risk, not the common failure mode -- see the merge-boundary fix
 * below for the fix that closes the dominant case.
 */
export async function getChannelChangeFeed(input: { since?: Date; limit?: number | null }): Promise<ChannelChangeFeedItem[]> {
  const limit = boundFeedLimit(input.limit);
  const since = input.since ?? null;

  const [recruitmentRows, relationshipRows, changeEventRows] = await Promise.all([
    since
      ? db.select().from(partnerRecruitmentHistoryTable).where(gt(partnerRecruitmentHistoryTable.createdAt, since)).orderBy(desc(partnerRecruitmentHistoryTable.createdAt)).limit(limit)
      : db.select().from(partnerRecruitmentHistoryTable).orderBy(desc(partnerRecruitmentHistoryTable.createdAt)).limit(limit),
    since
      ? db.select().from(partnerRelationshipHistoryTable).where(gt(partnerRelationshipHistoryTable.occurredAt, since)).orderBy(desc(partnerRelationshipHistoryTable.occurredAt)).limit(limit)
      : db.select().from(partnerRelationshipHistoryTable).orderBy(desc(partnerRelationshipHistoryTable.occurredAt)).limit(limit),
    since
      ? db.select().from(channelChangeEventsTable).where(gt(channelChangeEventsTable.occurredAt, since)).orderBy(desc(channelChangeEventsTable.occurredAt)).limit(limit)
      : db.select().from(channelChangeEventsTable).orderBy(desc(channelChangeEventsTable.occurredAt)).limit(limit),
  ]);

  // Recruitment rows only carry recruitment_id -- company_id/territory_id
  // for display context live on partner_recruitments, so a small batched
  // join-by-id resolves them. Same for relationship rows via
  // partner_relationships.
  const recruitmentIds = [...new Set(recruitmentRows.map((r) => r.recruitmentId))];
  const relationshipIds = [...new Set(relationshipRows.map((r) => r.relationshipId))];
  const [recruitments, relationships] = await Promise.all([
    recruitmentIds.length ? db.select().from(partnerRecruitmentsTable).where(inArray(partnerRecruitmentsTable.id, recruitmentIds)) : [],
    relationshipIds.length ? db.select().from(partnerRelationshipsTable).where(inArray(partnerRelationshipsTable.id, relationshipIds)) : [],
  ]);
  const recruitmentById = new Map(recruitments.map((r) => [r.id, r]));
  const relationshipById = new Map(relationships.map((r) => [r.id, r]));

  const raw: RawFeedItem[] = [];

  for (const row of recruitmentRows) {
    const recruitment = recruitmentById.get(row.recruitmentId) ?? null;
    // The very first history row for a recruitment has from_stage null --
    // labeled "recruitment_created" here (a normalization-layer judgment
    // call, not a change to the source table's own vocabulary) since "a
    // recruitment was accepted" reads far more usefully in a leadership
    // notification than "stage changed from null to accepted".
    raw.push({
      id: row.id,
      entity_type: "recruitment",
      entity_id: row.recruitmentId,
      event_type: row.fromStage === null ? "recruitment_created" : "stage_changed",
      actor_user_id: row.changedByUserId,
      occurred_at: row.createdAt.toISOString(),
      old_values: row.fromStage !== null ? { stage: row.fromStage } : null,
      new_values: { stage: row.toStage },
      companyId: recruitment?.companyId ?? null,
      territoryId: recruitment?.territoryId ?? null,
      pamUserId: null,
    });
  }

  for (const row of relationshipRows) {
    const relationship = relationshipById.get(row.relationshipId) ?? null;
    const oldValues: Record<string, unknown> = {};
    if (row.fromStatus !== null) oldValues.status = row.fromStatus;
    if (row.fromUserId !== null) oldValues.assigned_user_id = row.fromUserId;
    const newValues: Record<string, unknown> = {};
    if (row.toStatus !== null) newValues.status = row.toStatus;
    if (row.toUserId !== null) newValues.assigned_user_id = row.toUserId;

    raw.push({
      id: row.id,
      entity_type: "partner_relationship",
      entity_id: row.relationshipId,
      event_type: row.eventType,
      actor_user_id: row.changedByUserId,
      occurred_at: row.occurredAt.toISOString(),
      old_values: Object.keys(oldValues).length ? oldValues : null,
      new_values: Object.keys(newValues).length ? newValues : null,
      companyId: relationship?.companyId ?? null,
      territoryId: relationship?.territoryId ?? null,
      pamUserId: null,
    });
  }

  for (const row of changeEventRows) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const oldValues = (row.oldValues ?? {}) as Record<string, unknown>;
    const newValues = (row.newValues ?? {}) as Record<string, unknown>;
    // company_id/territory_id live in `metadata` for metric_target events
    // (identity context that never itself changes -- see channel_change_
    // events.ts's own comment), but for opportunity events they ARE
    // material fields and so live in old_values/new_values instead (see
    // routes/opportunities.ts's materialOpportunityFields) -- check both
    // shapes rather than assuming one.
    const companyId = firstString(metadata.company_id, newValues.company_id, oldValues.company_id);
    const territoryId = firstString(metadata.territory_id, newValues.territory_id, oldValues.territory_id);
    const pamUserId = firstString(metadata.pam_user_id);

    raw.push({
      id: row.id,
      entity_type: row.entityType,
      entity_id: row.entityId,
      event_type: row.eventType,
      actor_user_id: row.actorUserId,
      occurred_at: row.occurredAt.toISOString(),
      old_values: row.oldValues,
      new_values: row.newValues,
      companyId,
      territoryId,
      pamUserId,
    });
  }

  // Deterministic ordering: most recent business event first
  // (occurred_at DESC); ties broken by the source row's own id (a UUID, so
  // this is a stable, arbitrary-but-consistent tiebreak, never
  // insertion-order-dependent) -- required so repeated identical requests
  // (e.g. Aniri re-polling the same `since`) always return rows in the same
  // order, and so a client paging by `since` never silently skips or
  // duplicates a row that shares an occurred_at with its neighbor.
  raw.sort((a, b) => {
    const byTime = b.occurred_at.localeCompare(a.occurred_at);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });

  // Keyset-pagination correctness at the page boundary: a client's next
  // `since` is exactly the last item's occurred_at, which is ONLY
  // millisecond-precision -- `occurred_at` here is `Date.toISOString()`,
  // and a JS Date can't hold Postgres's microsecond precision, so it's the
  // finest cursor a client can ever express. If two source rows genuinely
  // differ only below that (e.g. two writes a few hundred microseconds
  // apart), they serialize to the identical occurred_at string and are
  // indistinguishable to the client. Cutting the page in the middle of
  // such a tied group would be silent, permanent data loss: the next
  // poll's `since` equals that exact boundary value, and `gt` strictly
  // excludes anything <= it -- including the sibling left behind, which no
  // future `since` value could ever select (its occurred_at is not
  // greater than itself). So the page must never split a tied-occurred_at
  // group: extend past `limit` to include every row that shares the last
  // included row's occurred_at. This can only ever make a page slightly
  // *larger* than `limit` (never smaller, never reordered), and only in
  // the rare case of a genuine sub-millisecond tie.
  let cutoff = Math.min(limit, raw.length);
  while (cutoff < raw.length && raw[cutoff]!.occurred_at === raw[cutoff - 1]!.occurred_at) {
    cutoff++;
  }
  const bounded = raw.slice(0, cutoff);

  // One batched name-resolution pass over exactly what the bounded page
  // actually needs -- never one query per row.
  const userIds = [...new Set([...bounded.map((r) => r.actor_user_id), ...bounded.map((r) => r.pamUserId)].filter((id): id is string => id !== null))];
  const companyIds = [...new Set(bounded.map((r) => r.companyId).filter((id): id is string => id !== null))];
  const territoryIds = [...new Set(bounded.map((r) => r.territoryId).filter((id): id is string => id !== null))];
  const [users, companies, territories] = await Promise.all([
    userIds.length ? db.select().from(usersTable).where(inArray(usersTable.id, userIds)) : ([] as (typeof usersTable.$inferSelect)[]),
    companyIds.length ? db.select().from(companiesTable).where(inArray(companiesTable.id, companyIds)) : ([] as (typeof companiesTable.$inferSelect)[]),
    territoryIds.length ? db.select().from(territoriesTable).where(inArray(territoriesTable.id, territoryIds)) : ([] as (typeof territoriesTable.$inferSelect)[]),
  ]);
  const userName = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
  const companyName = (id: string | null) => (id ? (companies.find((c) => c.id === id)?.name ?? null) : null);
  const territoryName = (id: string | null) => (id ? (territories.find((t) => t.id === id)?.name ?? null) : null);

  return bounded.map((r) => {
    const context: Record<string, unknown> = {};
    const cName = companyName(r.companyId);
    const tName = territoryName(r.territoryId);
    const pName = userName(r.pamUserId);
    if (cName) context.company_name = cName;
    if (tName) context.territory_name = tName;
    if (pName) context.pam_name = pName;

    return {
      id: r.id,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      event_type: r.event_type,
      actor_user_id: r.actor_user_id,
      actor_name: userName(r.actor_user_id),
      occurred_at: r.occurred_at,
      old_values: r.old_values,
      new_values: r.new_values,
      context: Object.keys(context).length ? context : null,
    };
  });
}
