import { db, channelChangeEventsTable, CHANNEL_CHANGE_ENTITY_TYPES, CHANNEL_CHANGE_EVENT_TYPES } from "@workspace/db";

// Aniri / Channel Chief evidence infrastructure (write side). One small,
// shared helper for the two entities that have no existing append-only
// history mechanism (metric_targets, partner_opportunities) -- see
// channel_change_events.ts's own header comment for why partner_recruitments
// and partner_relationships are deliberately NOT written through here.
//
// Same "run either standalone or embedded in a caller's own transaction"
// pattern as partnerRelationshipService.ts's Executor type -- every call
// site here is invoked from inside the business-write's own db.transaction,
// so the event insert is always atomic with the mutation it describes.
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export type ChannelChangeEntityType = (typeof CHANNEL_CHANGE_ENTITY_TYPES)[number];
export type ChannelChangeEventType = (typeof CHANNEL_CHANGE_EVENT_TYPES)[number];

export interface RecordChannelChangeEventInput {
  entityType: ChannelChangeEntityType;
  entityId: string;
  eventType: ChannelChangeEventType;
  actorUserId: string | null;
  occurredAt?: Date;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Inserts one append-only channel_change_events row. Deliberately has NO
 * "is this meaningful" logic of its own -- every caller decides that first
 * (see targetService.ts's diffTargetValues / routes/opportunities.ts's
 * diffMaterialOpportunityFields) and simply never calls this when there is
 * nothing material to record. This function only ever writes what it's
 * given.
 */
export async function recordChannelChangeEvent(executor: Executor, input: RecordChannelChangeEventInput): Promise<void> {
  await executor.insert(channelChangeEventsTable).values({
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt ?? new Date(),
    oldValues: input.oldValues,
    newValues: input.newValues,
    metadata: input.metadata ?? null,
  });
}
