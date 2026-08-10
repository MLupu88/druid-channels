import { db } from "@workspace/db";
import {
  partnerRelationshipsTable,
  partnerRelationshipHistoryTable,
  partnerActivitiesTable,
  territoriesTable,
  usersTable,
  type PartnerRelationship,
  type PartnerActivity,
  PARTNER_RELATIONSHIP_STATUSES,
  STARTED_AT_PRECISIONS,
  PARTNER_ACTIVITY_TYPES,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

// Stage 6 Partner Portfolio: the canonical relationship record. Canonical
// per (company, territory) -- see partner_relationships.ts's header comment
// for why. This module owns idempotent creation, status-transition
// validity, and event-based history -- deliberately small, mirroring
// partnerRecruitmentService.ts's own scope (not a generic state-machine
// framework).

export type RelationshipStatus = (typeof PARTNER_RELATIONSHIP_STATUSES)[number];
export type StartedAtPrecision = (typeof STARTED_AT_PRECISIONS)[number];

export class InvalidRelationshipTransitionError extends Error {}

// Lets createRelationshipIfMissing/recordRecruitmentSignedEvent run either
// standalone (self-contained transaction) or embedded inside a caller's own
// transaction (e.g. Recruitment's Signed transition) -- see each function.
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

// active <-> dormant <-> closed, with reactivation allowed directly from
// closed (matches the "one row per company+territory, ever" design --
// re-engaging a closed relationship is a status transition, not a new row).
export function isValidRelationshipTransition(from: RelationshipStatus, to: RelationshipStatus): boolean {
  if (from === to) return false;
  if (from === "active") return to === "dormant" || to === "closed";
  if (from === "dormant") return to === "active" || to === "closed";
  if (from === "closed") return to === "active";
  return false;
}

export function eventTypeForTransition(from: RelationshipStatus, to: RelationshipStatus): "reactivated" | "closed" | "status_changed" {
  if (to === "active" && (from === "dormant" || from === "closed")) return "reactivated";
  if (to === "closed") return "closed";
  return "status_changed";
}

// Period-eligibility for "New Partners in period" reporting. Never a plain
// date-range filter alone: a year-precision date anchored at Jan 1st would
// otherwise look like it belongs in Q1, which is exactly the fabrication
// this guards against. unknown precision is excluded from every period.
export function isEligibleForPeriodMetric(precision: StartedAtPrecision, periodGranularity: "quarter" | "year"): boolean {
  if (precision === "unknown") return false;
  if (periodGranularity === "year") return true;
  // quarter granularity: exact_date, month, quarter are usable; year is not
  // (a year-only date cannot honestly be attributed to one specific quarter).
  return precision === "exact_date" || precision === "month" || precision === "quarter";
}

export interface CreateRelationshipInput {
  companyId: string;
  territoryId: string;
  assignedUserId?: string | null;
  status?: RelationshipStatus;
  partnerType?: string | null;
  strategicImportance?: "high" | "medium" | "low" | null;
  relationshipSummary?: string | null;
  relationshipStartedAt?: string | null;
  startedAtPrecision?: StartedAtPrecision;
  startedAtProvenance?: "explicit" | "inferred" | "user_confirmed" | "system_generated" | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  originType: "recruitment" | "pam_import" | "manual";
  originRecruitmentId?: string | null;
  sourceAsOfDate?: string | null;
  importedAt?: Date | null;
}

// Idempotent on (company_id, territory_id): a repeated create (e.g. Signed
// firing twice, or an import row re-confirmed) never duplicates or
// overwrites an existing relationship. Returns the existing row untouched
// when one already exists -- callers that need to react to "already
// existed" (e.g. append a recruitment_signed event) do so themselves using
// the returned `created` flag.
export async function createRelationshipIfMissing(
  input: CreateRelationshipInput,
  actingUserId: string | null,
  executor?: Executor,
): Promise<{ relationship: PartnerRelationship; created: boolean }> {
  const body = async (tx: Executor) => {
    const [inserted] = await tx
      .insert(partnerRelationshipsTable)
      .values({
        companyId: input.companyId,
        territoryId: input.territoryId,
        assignedUserId: input.assignedUserId ?? null,
        status: input.status ?? "active",
        partnerType: input.partnerType ?? null,
        strategicImportance: input.strategicImportance ?? null,
        relationshipSummary: input.relationshipSummary ?? null,
        relationshipStartedAt: input.relationshipStartedAt ?? null,
        startedAtPrecision: input.startedAtPrecision ?? "unknown",
        startedAtProvenance: input.startedAtProvenance ?? null,
        nextAction: input.nextAction ?? null,
        nextActionDueAt: input.nextActionDueAt ?? null,
        originType: input.originType,
        originRecruitmentId: input.originRecruitmentId ?? null,
        sourceAsOfDate: input.sourceAsOfDate ?? null,
        importedAt: input.importedAt ?? null,
      })
      .onConflictDoNothing({ target: [partnerRelationshipsTable.companyId, partnerRelationshipsTable.territoryId] })
      .returning();

    if (inserted) {
      await tx.insert(partnerRelationshipHistoryTable).values({
        relationshipId: inserted.id,
        eventType: "created",
        toStatus: inserted.status as RelationshipStatus,
        sourceRecruitmentId: input.originRecruitmentId ?? null,
        changedByUserId: actingUserId,
      });
      return { relationship: inserted, created: true };
    }

    const [existing] = await tx
      .select()
      .from(partnerRelationshipsTable)
      .where(and(eq(partnerRelationshipsTable.companyId, input.companyId), eq(partnerRelationshipsTable.territoryId, input.territoryId)));
    return { relationship: existing!, created: false };
  };

  if (executor) return body(executor);
  return db.transaction(body);
}

// Appends a recruitment_signed event to an already-existing relationship
// without touching its status/origin -- origin_type is set once at
// creation and is never rewritten (see partner_relationships.ts header).
export async function recordRecruitmentSignedEvent(
  relationshipId: string,
  recruitmentId: string,
  signedAt: Date,
  actingUserId: string | null,
  executor: Executor = db,
): Promise<void> {
  await executor.insert(partnerRelationshipHistoryTable).values({
    relationshipId,
    eventType: "recruitment_signed",
    sourceRecruitmentId: recruitmentId,
    occurredAt: signedAt,
    changedByUserId: actingUserId,
  });
}

export interface TransitionStatusOptions {
  occurredAt?: Date;
  note?: string | null;
}

export async function transitionRelationshipStatus(
  relationshipId: string,
  toStatus: RelationshipStatus,
  actingUserId: string,
  opts: TransitionStatusOptions = {},
): Promise<PartnerRelationship | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, relationshipId));
    if (!existing) return null;

    const fromStatus = existing.status as RelationshipStatus;
    if (!isValidRelationshipTransition(fromStatus, toStatus)) {
      throw new InvalidRelationshipTransitionError(`Cannot move from "${fromStatus}" to "${toStatus}".`);
    }

    const now = new Date();
    // occurredAt may be backdated (e.g. "this actually closed in May, not
    // today") -- relationship_ended_at must reflect that same occurredAt,
    // never silently now(). Reactivating clears it: the relationship is no
    // longer ended, and the historical close/reopen dates remain fully
    // queryable via partner_relationship_history regardless.
    const effectiveOccurredAt = opts.occurredAt ?? now;
    const updates: Partial<typeof partnerRelationshipsTable.$inferInsert> = { status: toStatus, updatedAt: now };
    if (toStatus === "closed") updates.relationshipEndedAt = effectiveOccurredAt.toISOString().slice(0, 10);
    if (toStatus === "active" && (fromStatus === "dormant" || fromStatus === "closed")) updates.relationshipEndedAt = null;

    const [updated] = await tx.update(partnerRelationshipsTable).set(updates).where(eq(partnerRelationshipsTable.id, relationshipId)).returning();

    await tx.insert(partnerRelationshipHistoryTable).values({
      relationshipId,
      eventType: eventTypeForTransition(fromStatus, toStatus),
      fromStatus,
      toStatus,
      occurredAt: effectiveOccurredAt,
      note: opts.note ?? null,
      changedByUserId: actingUserId,
    });

    return updated!;
  });
}

export class ReassignmentTerritoryMismatchError extends Error {}

// Global-only in practice (enforced by the route, not here) -- a PAM must
// never call this against a relationship they don't already own.
//
// With the v1 one-PAM-one-territory model, a relationship's assigned PAM
// must be the canonical owner (territories.owner_user_id) of that
// relationship's own territory -- reassigning across territories would
// create a record the authorization model can never make sense of again.
// If Irina wants a different PAM on this relationship, territory
// ownership must change first (via /territories or Add PAM), not this
// endpoint.
export async function reassignRelationshipOwner(
  relationshipId: string,
  toUserId: string | null,
  actingUserId: string,
): Promise<PartnerRelationship | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, relationshipId));
    if (!existing) return null;

    if (toUserId) {
      const [territory] = await tx.select().from(territoriesTable).where(eq(territoriesTable.id, existing.territoryId));
      if (territory?.ownerUserId !== toUserId) {
        const [targetUser] = await tx.select().from(usersTable).where(eq(usersTable.id, toUserId));
        throw new ReassignmentTerritoryMismatchError(
          `${targetUser?.name ?? "That PAM"} does not own ${territory?.name ?? "this relationship's territory"}. ` +
            `Change territory ownership first (Settings > Team) before reassigning this relationship.`,
        );
      }
    }

    const [updated] = await tx
      .update(partnerRelationshipsTable)
      .set({ assignedUserId: toUserId, updatedAt: new Date() })
      .where(eq(partnerRelationshipsTable.id, relationshipId))
      .returning();

    await tx.insert(partnerRelationshipHistoryTable).values({
      relationshipId,
      eventType: "owner_changed",
      fromUserId: existing.assignedUserId,
      toUserId,
      changedByUserId: actingUserId,
    });

    return updated!;
  });
}

export interface AddActivityInput {
  relationshipId: string;
  activityType: (typeof PARTNER_ACTIVITY_TYPES)[number];
  note: string;
  occurredAt: Date;
  actorUserId: string | null;
}

// Inserts the activity and recomputes last_interaction_at in the same
// transaction (denormalized, never re-derived on every read -- same
// convention as partner_recruitments.stageEnteredAt).
export async function addActivity(input: AddActivityInput): Promise<PartnerActivity> {
  return db.transaction(async (tx) => {
    const [activity] = await tx
      .insert(partnerActivitiesTable)
      .values({
        relationshipId: input.relationshipId,
        actorUserId: input.actorUserId,
        activityType: input.activityType,
        note: input.note,
        occurredAt: input.occurredAt,
      })
      .returning();

    const [relationship] = await tx.select().from(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.id, input.relationshipId));
    if (relationship && (!relationship.lastInteractionAt || relationship.lastInteractionAt < input.occurredAt)) {
      await tx
        .update(partnerRelationshipsTable)
        .set({ lastInteractionAt: input.occurredAt, updatedAt: new Date() })
        .where(eq(partnerRelationshipsTable.id, input.relationshipId));
    }

    return activity!;
  });
}

export async function findRelationshipByCompanyAndTerritory(companyId: string, territoryId: string): Promise<PartnerRelationship | null> {
  const [row] = await db
    .select()
    .from(partnerRelationshipsTable)
    .where(and(eq(partnerRelationshipsTable.companyId, companyId), eq(partnerRelationshipsTable.territoryId, territoryId)));
  return row ?? null;
}

export interface ExistingPartnerContext {
  relationship: { id: string; status: string; territory_name: string | null; assigned_user_name: string | null } | null;
}

// Read-only cross-domain lookup for Recruitment/Radar detail views (see
// routes/recruitment.ts, routes/channel_radar.ts). Never creates,
// reassigns, or reopens anything -- purely informational.
export async function getExistingPartnerContext(companyId: string | null, territoryId: string): Promise<ExistingPartnerContext> {
  if (!companyId) return { relationship: null };

  const [row] = await db
    .select({ relationship: partnerRelationshipsTable, territory: territoriesTable, assignedUser: usersTable })
    .from(partnerRelationshipsTable)
    .leftJoin(territoriesTable, eq(partnerRelationshipsTable.territoryId, territoriesTable.id))
    .leftJoin(usersTable, eq(partnerRelationshipsTable.assignedUserId, usersTable.id))
    .where(and(eq(partnerRelationshipsTable.companyId, companyId), eq(partnerRelationshipsTable.territoryId, territoryId)));

  if (!row) return { relationship: null };
  return {
    relationship: {
      id: row.relationship.id,
      status: row.relationship.status,
      territory_name: row.territory?.name ?? null,
      assigned_user_name: row.assignedUser?.name ?? null,
    },
  };
}
