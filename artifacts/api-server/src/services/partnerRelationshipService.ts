import { db } from "@workspace/db";
import {
  partnerRelationshipsTable,
  partnerRelationshipHistoryTable,
  partnerActivitiesTable,
  partnerRecruitmentsTable,
  channelRadarSignalsTable,
  territoriesTable,
  usersTable,
  type PartnerRelationship,
  type PartnerActivity,
  type PartnerRecruitment,
  PARTNER_RELATIONSHIP_STATUSES,
  STARTED_AT_PRECISIONS,
  PARTNER_ACTIVITY_TYPES,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

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
// needs_review is entry-only: a human resolves it into any of the three real
// lifecycle states, but nothing ever transitions back into it -- it is not a
// fourth lifecycle state, just an unclassified starting point (see
// PARTNER_RELATIONSHIP_STATUSES in schema/partner_relationships.ts).
export function isValidRelationshipTransition(from: RelationshipStatus, to: RelationshipStatus): boolean {
  if (from === to) return false;
  if (from === "active") return to === "dormant" || to === "closed";
  if (from === "dormant") return to === "active" || to === "closed";
  if (from === "closed") return to === "active";
  if (from === "needs_review") return to === "active" || to === "dormant" || to === "closed";
  return false;
}

// Shared "needs attention" rule: either an active relationship with no next
// action set and no interaction in the last 30 days (or never), OR any
// needs_review relationship unconditionally (an unclassified relationship
// always needs a human look, regardless of next_action/last_interaction_at
// -- those fields are rarely even populated yet for one). Exported so
// routes/portfolio.ts's summary count, the Copilot's
// getPartnersNeedingAttention (copilotContextService.ts), and
// channelChiefContextService's getPortfolioSnapshot apply the exact same
// rule rather than three independently-maintained copies.
const ATTENTION_STALE_MS = 30 * 24 * 60 * 60 * 1000;

export function isNeedingAttention(r: Pick<PartnerRelationship, "status" | "nextAction" | "lastInteractionAt">, now: Date = new Date()): boolean {
  if (r.status === "needs_review") return true;
  if (r.status !== "active") return false;
  if (r.nextAction) return false;
  const lastInteractionMs = r.lastInteractionAt ? r.lastInteractionAt.getTime() : null;
  return lastInteractionMs === null || lastInteractionMs < now.getTime() - ATTENTION_STALE_MS;
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
  originType: "recruitment" | "pam_import" | "manual" | "opportunity_import";
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

// Phase 12 Portfolio Reconciliation: an opportunity's own assigned_user_id
// is always a real user FK (partner_opportunities.assigned_user_id is
// NOT NULL), but that alone does not mean it's safe to copy onto the
// auto-created relationship as its owning PAM -- the referenced user could
// have been deactivated since, or (for historical/cutover rows) may not
// actually hold the "pam" role at all, or may own a different territory
// than the opportunity's. Only ever returns the assignee when they are
// currently an active PAM who canonically owns the opportunity's own
// territory (territories.owner_user_id -- the same one-PAM-one-territory
// rule resolveRelationshipAssigneeForRecruitment and
// reassignRelationshipOwner enforce); otherwise null, so the relationship
// is created unassigned and surfaces as unresolved_pam. Never substitutes
// the territory's owner for a differently-named assignee -- that would
// invent an owner the opportunity didn't name. Exported for direct unit
// testing.
export async function resolveRelationshipAssigneeForOpportunity(
  opportunityAssignedUserId: string,
  territoryId: string,
  executor: Executor = db,
): Promise<string | null> {
  const [user] = await executor.select().from(usersTable).where(eq(usersTable.id, opportunityAssignedUserId));
  if (!user || !user.active || user.role !== "pam") return null;
  const [territory] = await executor.select().from(territoriesTable).where(eq(territoriesTable.id, territoryId));
  return territory?.ownerUserId === user.id ? user.id : null;
}

export interface ReconcilePortfolioForOpportunityInput {
  companyId: string;
  territoryId: string;
  // The opportunity's own assigned_user_id -- NOT trusted verbatim as the
  // relationship's PAM, see resolveRelationshipAssigneeForOpportunity above.
  opportunityAssignedUserId: string;
}

export interface ReconcilePortfolioForOpportunityResult {
  relationship: PartnerRelationship;
  created: boolean;
  resolvedAssignedUserId: string | null;
}

// Phase 12 Portfolio Reconciliation: called whenever an opportunity is
// created (manual or imported -- see applyOpportunityCreate in
// routes/opportunities.ts) so that every company an opportunity references
// has SOME Portfolio relationship, without ever fabricating an Active
// status the app doesn't actually know to be true. Idempotent via
// createRelationshipIfMissing's own (company_id, territory_id)
// onConflictDoNothing -- re-importing the same opportunity, or creating a
// second opportunity for an already-portfolio'd company, never creates a
// duplicate relationship and never overwrites/touches an existing one's
// fields (status, PAM, next_action, etc. all stay exactly as a human left
// them). Only ever creates with status "needs_review" and origin_type
// "opportunity_import" -- never "active", never any other origin.
// relationship_started_at/started_at_precision are deliberately left at
// their "unknown" defaults -- an opportunity's own date is a deal date, not
// a partnership start date, and must never be repurposed as one.
export async function reconcilePortfolioRelationshipForOpportunity(
  input: ReconcilePortfolioForOpportunityInput,
  actingUserId: string | null,
  executor: Executor = db,
): Promise<ReconcilePortfolioForOpportunityResult> {
  const resolvedAssignedUserId = await resolveRelationshipAssigneeForOpportunity(input.opportunityAssignedUserId, input.territoryId, executor);

  const { relationship, created } = await createRelationshipIfMissing(
    {
      companyId: input.companyId,
      territoryId: input.territoryId,
      assignedUserId: resolvedAssignedUserId,
      status: "needs_review",
      originType: "opportunity_import",
    },
    actingUserId,
    executor,
  );

  return { relationship, created, resolvedAssignedUserId };
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

// ---- Canonical Portfolio Truth: signed recruitment -> Portfolio -----------
//
// Recruitment stage semantics: accepted = accepted INTO recruitment;
// contacting/engaged/agreement = recruitment pipeline; signed = confirmed
// partner. Only a recruitment whose CURRENT stage is "signed" is ever
// allowed to establish or confirm a Portfolio relationship -- earlier
// stages are pipeline, not partnership, and legacy prospects.status
// (accepted/pushed_to_hubspot) is never consulted at all. This is the one
// shared path used by both the live Signed transition
// (partnerRecruitmentService.transitionRecruitmentStage) and the historical
// backfill (scripts/backfillPortfolioFromSignedRecruitments.ts).

export class RecruitmentNotSignedError extends Error {}

export type SignedRecruitmentEvidence = Pick<PartnerRecruitment, "id" | "companyId" | "territoryId" | "assignedUserId" | "stage" | "signedAt">;

// Safe PAM for a relationship created from a signed recruitment, under the
// current one-PAM-one-territory model (see reassignRelationshipOwner below,
// which enforces the same rule on manual reassignment): the assignee must
// be an active PAM who owns the recruitment's own territory. If the
// recruitment carries an assignee, it must satisfy that rule or nothing is
// assigned (never silently swapped for someone else); if it carries none,
// the territory's canonical owner is used when that owner is an active PAM.
// Otherwise null -- the relationship is created unassigned rather than
// inventing an owner.
export async function resolveRelationshipAssigneeForRecruitment(
  recruitment: Pick<PartnerRecruitment, "territoryId" | "assignedUserId">,
  executor: Executor = db,
): Promise<string | null> {
  const [territory] = await executor.select().from(territoriesTable).where(eq(territoriesTable.id, recruitment.territoryId));
  const ownerUserId = territory?.ownerUserId ?? null;
  if (!ownerUserId) return null;
  if (recruitment.assignedUserId && recruitment.assignedUserId !== ownerUserId) return null;
  const [owner] = await executor.select().from(usersTable).where(eq(usersTable.id, ownerUserId));
  return owner && owner.active && owner.role === "pam" ? owner.id : null;
}

export type SignedRecruitmentPlanAction = "create" | "promote" | "reuse";

export interface SignedRecruitmentPlan {
  // create: no relationship exists for (company, territory) yet.
  // promote: one exists as needs_review (e.g. inferred from opportunity
  //   evidence) -- the signed recruitment confirms it as active.
  // reuse: one exists as active/dormant/closed -- a human (or an earlier
  //   confirmation) already classified it; its status is left untouched.
  action: SignedRecruitmentPlanAction;
  existing: PartnerRelationship | null;
  // Only meaningful for "create" -- an existing relationship's
  // assigned_user_id is manually managed and never rewritten here.
  resolvedAssignedUserId: string | null;
  // True when the existing relationship doesn't already record this
  // recruitment as its origin or via a recruitment_signed event.
  needsSignedEvent: boolean;
}

// Read-only: what reconcilePortfolioRelationshipForSignedRecruitment would
// do for this recruitment. Used directly by the backfill's dry run, so a
// dry run and an apply can never disagree about the plan.
export async function planSignedRecruitmentReconciliation(
  recruitment: SignedRecruitmentEvidence,
  executor: Executor = db,
): Promise<SignedRecruitmentPlan> {
  if (recruitment.stage !== "signed") {
    throw new RecruitmentNotSignedError(`Recruitment ${recruitment.id} is "${recruitment.stage}", not "signed" -- only a signed recruitment confirms a Portfolio relationship.`);
  }

  const [existing] = await executor
    .select()
    .from(partnerRelationshipsTable)
    .where(and(eq(partnerRelationshipsTable.companyId, recruitment.companyId), eq(partnerRelationshipsTable.territoryId, recruitment.territoryId)));

  if (!existing) {
    return { action: "create", existing: null, resolvedAssignedUserId: await resolveRelationshipAssigneeForRecruitment(recruitment, executor), needsSignedEvent: false };
  }

  let needsSignedEvent = existing.originRecruitmentId !== recruitment.id;
  if (needsSignedEvent) {
    const [priorEvent] = await executor
      .select({ id: partnerRelationshipHistoryTable.id })
      .from(partnerRelationshipHistoryTable)
      .where(
        and(
          eq(partnerRelationshipHistoryTable.relationshipId, existing.id),
          eq(partnerRelationshipHistoryTable.eventType, "recruitment_signed"),
          eq(partnerRelationshipHistoryTable.sourceRecruitmentId, recruitment.id),
        ),
      );
    needsSignedEvent = !priorEvent;
  }

  return { action: existing.status === "needs_review" ? "promote" : "reuse", existing, resolvedAssignedUserId: null, needsSignedEvent };
}

export interface ReconcileSignedRecruitmentResult {
  relationship: PartnerRelationship;
  action: "created" | "promoted" | "reused";
  resolvedAssignedUserId: string | null;
  signedEventRecorded: boolean;
}

// Idempotent. Never creates a duplicate (createRelationshipIfMissing's
// (company_id, territory_id) onConflictDoNothing), never rewrites
// origin_type/origin_recruitment_id of an existing relationship (an
// opportunity_import relationship stays opportunity_import -- the
// confirmation is recorded as history, not as rewritten provenance), and
// never touches manually managed fields (PAM, next_action, summary,
// importance, partner_type) of an existing one.
//
//   - none exists: create active, origin_type=recruitment,
//     origin_recruitment_id=this recruitment, started_at=signed date.
//   - needs_review: promote to active (status_changed event carrying
//     source_recruitment_id) + a recruitment_signed event. If the start
//     date is still unknown, it is filled from the signed date -- that is
//     the confirmed start of the partnership, not a fabrication.
//   - active/dormant/closed: status untouched; only a recruitment_signed
//     event is appended (once).
export async function reconcilePortfolioRelationshipForSignedRecruitment(
  recruitment: SignedRecruitmentEvidence,
  actingUserId: string | null,
  executor?: Executor,
): Promise<ReconcileSignedRecruitmentResult> {
  const body = async (tx: Executor): Promise<ReconcileSignedRecruitmentResult> => {
    const signedAt = recruitment.signedAt;
    const signedDate = signedAt ? signedAt.toISOString().slice(0, 10) : null;
    const occurredAt = signedAt ?? new Date();

    let plan = await planSignedRecruitmentReconciliation(recruitment, tx);

    if (plan.action === "create") {
      const { relationship, created } = await createRelationshipIfMissing(
        {
          companyId: recruitment.companyId,
          territoryId: recruitment.territoryId,
          assignedUserId: plan.resolvedAssignedUserId,
          status: "active",
          relationshipStartedAt: signedDate,
          startedAtPrecision: signedDate ? "exact_date" : "unknown",
          startedAtProvenance: signedDate ? "system_generated" : null,
          originType: "recruitment",
          originRecruitmentId: recruitment.id,
        },
        actingUserId,
        tx,
      );
      if (created) return { relationship, action: "created", resolvedAssignedUserId: plan.resolvedAssignedUserId, signedEventRecorded: false };
      // Created concurrently between the plan and the insert -- re-plan
      // against the row that now exists rather than assuming its state.
      plan = await planSignedRecruitmentReconciliation(recruitment, tx);
    }

    let relationship = plan.existing!;
    let action: ReconcileSignedRecruitmentResult["action"] = "reused";

    if (plan.action === "promote") {
      const updates: Partial<typeof partnerRelationshipsTable.$inferInsert> = { status: "active", updatedAt: new Date() };
      if (signedDate && !relationship.relationshipStartedAt && relationship.startedAtPrecision === "unknown") {
        updates.relationshipStartedAt = signedDate;
        updates.startedAtPrecision = "exact_date";
        updates.startedAtProvenance = "system_generated";
      }
      // Conditional on still being needs_review, so a concurrent human
      // classification (or a second reconcile) is never overwritten.
      const [promoted] = await tx
        .update(partnerRelationshipsTable)
        .set(updates)
        .where(and(eq(partnerRelationshipsTable.id, relationship.id), eq(partnerRelationshipsTable.status, "needs_review")))
        .returning();
      if (promoted) {
        await tx.insert(partnerRelationshipHistoryTable).values({
          relationshipId: promoted.id,
          eventType: eventTypeForTransition("needs_review", "active"),
          fromStatus: "needs_review",
          toStatus: "active",
          sourceRecruitmentId: recruitment.id,
          occurredAt,
          note: "Confirmed by signed recruitment",
          changedByUserId: actingUserId,
        });
        relationship = promoted;
        action = "promoted";
      }
    }

    if (plan.needsSignedEvent) {
      await recordRecruitmentSignedEvent(relationship.id, recruitment.id, occurredAt, actingUserId, tx);
    }

    return { relationship, action, resolvedAssignedUserId: null, signedEventRecorded: plan.needsSignedEvent };
  };

  if (executor) return body(executor);
  return db.transaction(body);
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

// Recruitment/Radar context shown on a Portfolio relationship's detail
// view. A relationship is canonical per (company, territory), and the same
// company can legitimately be recruited or surface Radar signals in more
// than one territory -- so both lookups are scoped to the relationship's
// own (company_id, territory_id), never company_id alone, or one
// territory's detail would show another territory's recruitment/signals.
export async function getRelationshipScopedContext(
  relationship: Pick<PartnerRelationship, "companyId" | "territoryId">,
  radarSignalLimit = 5,
) {
  const [recruitments, radarSignals] = await Promise.all([
    db
      .select()
      .from(partnerRecruitmentsTable)
      .where(and(eq(partnerRecruitmentsTable.companyId, relationship.companyId), eq(partnerRecruitmentsTable.territoryId, relationship.territoryId)))
      .orderBy(desc(partnerRecruitmentsTable.updatedAt)),
    db
      .select()
      .from(channelRadarSignalsTable)
      .where(and(eq(channelRadarSignalsTable.companyId, relationship.companyId), eq(channelRadarSignalsTable.territoryId, relationship.territoryId)))
      .orderBy(desc(channelRadarSignalsTable.discoveredAt))
      .limit(radarSignalLimit),
  ]);
  return { latestRecruitment: recruitments[0] ?? null, radarSignals };
}
