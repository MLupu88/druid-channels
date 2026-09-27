import { db } from "@workspace/db";
import {
  partnerRecruitmentsTable,
  partnerRecruitmentHistoryTable,
  type PartnerRecruitment,
  RECRUITMENT_STAGES,
  NOT_PURSUING_REASONS,
} from "@workspace/db";
import { eq, and, inArray, gte, lt } from "drizzle-orm";
import { reconcilePortfolioRelationshipForSignedRecruitment } from "./partnerRelationshipService";

// Stage 4: the recruitment PROCESS for one accepted Discovery prospect.
// Deliberately small and stage-derived rather than a generic state-machine
// framework or activity engine -- see partner_recruitments.ts's own header
// comment for why this is a separate table from prospects.

export type RecruitmentStage = (typeof RECRUITMENT_STAGES)[number];

const ACTIVE_STAGES: readonly RecruitmentStage[] = ["accepted", "contacting", "engaged", "agreement"];

// Forward funnel only -- matches the exact labeled actions in the product
// spec. Every other transition (on_hold, not_pursuing, resume) is handled
// as its own special case in isValidTransition below.
const FORWARD_TRANSITIONS: Partial<Record<RecruitmentStage, RecruitmentStage>> = {
  accepted: "contacting",
  contacting: "engaged",
  engaged: "agreement",
  agreement: "signed",
};

// Server-side only, matching the labels in the product spec. Exposed via
// getNextStageAction() so the frontend never has to hardcode/duplicate
// this mapping -- but it's a plain lookup, not a generic next-action engine.
const NEXT_STAGE_ACTION: Partial<Record<RecruitmentStage, { stage: RecruitmentStage; label: string }>> = {
  accepted: { stage: "contacting", label: "Start outreach" },
  contacting: { stage: "engaged", label: "Mark engaged" },
  engaged: { stage: "agreement", label: "Start agreement" },
  agreement: { stage: "signed", label: "Mark signed" },
};

export function getNextStageAction(stage: RecruitmentStage): { stage: RecruitmentStage; label: string } | null {
  return NEXT_STAGE_ACTION[stage] ?? null;
}

export function isActiveStage(stage: RecruitmentStage): boolean {
  return ACTIVE_STAGES.includes(stage);
}

// Signed and not_pursuing are terminal in v1 -- no transitions out of
// either. on_hold can only ever resume back into the exact stage it was
// put on hold from (never an arbitrary target). Every other move must be
// the single forward step defined above, or into on_hold/not_pursuing from
// an active stage.
export function isValidTransition(current: { stage: string; previousStage: string | null }, to: RecruitmentStage): boolean {
  const from = current.stage as RecruitmentStage;
  if (from === to) return false;
  if (from === "signed" || from === "not_pursuing") return false;
  if (from === "on_hold") return to === current.previousStage;
  if (to === "on_hold") return isActiveStage(from);
  if (to === "not_pursuing") return isActiveStage(from);
  return FORWARD_TRANSITIONS[from] === to;
}

export class InvalidTransitionError extends Error {}

export function computeDaysInStage(stageEnteredAt: Date): number {
  return Math.max(0, Math.floor((Date.now() - stageEnteredAt.getTime()) / 86_400_000));
}

export function isStalled(stage: string, daysInStage: number): boolean {
  return isActiveStage(stage as RecruitmentStage) && daysInStage > 14;
}

// Idempotent / conflict-safe: a repeated "Accept for Recruitment" on the
// same prospect must never create a duplicate row, and must never reset an
// already-progressed recruitment back to "accepted". The unique prospectId
// column + onConflictDoNothing (same atomic-upsert convention used
// elsewhere in this codebase) makes the second call a true no-op rather
// than needing a separate select-then-insert race window.
export async function acceptForRecruitment(
  prospect: { id: string; companyId: string; territoryId: string; assignedUserId: string | null },
  actingUserId: string,
): Promise<{ recruitment: PartnerRecruitment; created: boolean }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [inserted] = await tx
      .insert(partnerRecruitmentsTable)
      .values({
        prospectId: prospect.id,
        companyId: prospect.companyId,
        territoryId: prospect.territoryId,
        assignedUserId: prospect.assignedUserId,
        stage: "accepted",
        stageEnteredAt: now,
      })
      .onConflictDoNothing({ target: partnerRecruitmentsTable.prospectId })
      .returning();

    if (inserted) {
      await tx.insert(partnerRecruitmentHistoryTable).values({
        recruitmentId: inserted.id,
        fromStage: null,
        toStage: "accepted",
        changedByUserId: actingUserId,
      });
      return { recruitment: inserted, created: true };
    }

    const [existing] = await tx.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.prospectId, prospect.id));
    return { recruitment: existing!, created: false };
  });
}

// Phase 11.1: partner_recruitments.prospectId has onDelete: cascade against
// prospects.id (see partner_recruitments.ts), so partner_recruitment_history
// cascades again from there -- a naive prospect delete can silently wipe a
// recruitment's full stage-change history, including a signed partner's
// trail. This guard blocks that at the application layer, before Postgres's
// cascade ever runs, regardless of stage (including terminal ones) -- once
// a prospect has been handed off to Recruitment, it stops being something
// Discovery can delete outright; the recruitment record's own lifecycle
// (see isValidTransition above) is the only way to move it out of the way.
export class ProspectHasRecruitmentError extends Error {}

export async function assertProspectHasNoRecruitment(prospectId: string): Promise<void> {
  const [existing] = await db
    .select({ id: partnerRecruitmentsTable.id })
    .from(partnerRecruitmentsTable)
    .where(eq(partnerRecruitmentsTable.prospectId, prospectId));
  if (existing) {
    throw new ProspectHasRecruitmentError(
      "This prospect is already part of the recruitment process and cannot be permanently deleted. Update the recruitment stage instead.",
    );
  }
}

export interface TransitionOptions {
  note?: string | null;
  notPursuingReason?: (typeof NOT_PURSUING_REASONS)[number] | null;
}

// Single atomic transaction: read current stage, validate, write the new
// stage + bookkeeping fields, append one history row. previousStage is only
// ever meaningful while on_hold (what to resume into); it's set on the way
// in and cleared on the way out.
export async function transitionRecruitmentStage(
  recruitmentId: string,
  toStage: RecruitmentStage,
  actingUserId: string,
  opts: TransitionOptions = {},
): Promise<PartnerRecruitment | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.id, recruitmentId));
    if (!existing) return null;

    if (!isValidTransition(existing, toStage)) {
      throw new InvalidTransitionError(`Cannot move from "${existing.stage}" to "${toStage}".`);
    }
    if (toStage === "not_pursuing" && !opts.notPursuingReason) {
      throw new InvalidTransitionError("A reason is required to stop pursuing.");
    }

    const now = new Date();
    const updates: Partial<typeof partnerRecruitmentsTable.$inferInsert> = {
      stage: toStage,
      stageEnteredAt: now,
      updatedAt: now,
    };
    if (toStage === "on_hold") {
      updates.previousStage = existing.stage as RecruitmentStage;
    } else if (existing.stage === "on_hold") {
      updates.previousStage = null;
    }
    if (toStage === "not_pursuing") {
      updates.notPursuingReason = opts.notPursuingReason ?? null;
    }
    if (toStage === "signed") {
      updates.signedAt = now;
    }

    const [updated] = await tx.update(partnerRecruitmentsTable).set(updates).where(eq(partnerRecruitmentsTable.id, recruitmentId)).returning();

    await tx.insert(partnerRecruitmentHistoryTable).values({
      recruitmentId,
      fromStage: existing.stage as RecruitmentStage,
      toStage,
      note: opts.note ?? null,
      changedByUserId: actingUserId,
    });

    // Stage 6 / Canonical Portfolio Truth: Signed -- and only Signed --
    // establishes or confirms the canonical Partner Relationship for this
    // (company, territory), in this same transaction. Earlier stages
    // (accepted/contacting/engaged/agreement) are recruitment pipeline and
    // never touch Portfolio. See
    // reconcilePortfolioRelationshipForSignedRecruitment for the
    // create / promote-needs_review / reuse rules, shared with the
    // historical backfill.
    if (toStage === "signed" && updated) {
      await reconcilePortfolioRelationshipForSignedRecruitment(updated, actingUserId, tx);
    }

    return updated!;
  });
}

// ---- Phase 8: management-reporting funnel views ---------------------------
//
// Deliberately two separate, non-interchangeable views -- never blur a live
// snapshot with a period's worth of movement:
//   - current_state: where the pipeline stands RIGHT NOW (live, not
//     period-bound).
//   - period_transitions: what actually MOVED during an explicit period,
//     sourced from the append-only partner_recruitment_history table --
//     the exact same "genuine movement" query weeklyReportingService.ts's
//     buildRecruitmentSection already uses for one PAM/one week, generalized
//     to an arbitrary territory scope and date range.

export interface RecruitmentScope {
  // null = unrestricted (Global); otherwise the exact territory id set to
  // include -- same "explicit list, no implicit fallback" convention as
  // kpiService.OpportunityScope's "territory"/"pam" variants.
  territoryIds: string[] | null;
}

export interface RecruitmentCurrentState {
  as_of: string;
  by_stage: Record<RecruitmentStage, number>;
}

function emptyStageCounts(): Record<RecruitmentStage, number> {
  return Object.fromEntries(RECRUITMENT_STAGES.map((s) => [s, 0])) as Record<RecruitmentStage, number>;
}

export async function computeRecruitmentCurrentState(scope: RecruitmentScope): Promise<RecruitmentCurrentState> {
  const rows = await db
    .select({ stage: partnerRecruitmentsTable.stage })
    .from(partnerRecruitmentsTable)
    .where(scope.territoryIds ? inArray(partnerRecruitmentsTable.territoryId, scope.territoryIds) : undefined);

  const by_stage = emptyStageCounts();
  for (const r of rows) by_stage[r.stage as RecruitmentStage]++;
  return { as_of: new Date().toISOString(), by_stage };
}

export interface RecruitmentPeriodTransitions {
  period_start: string;
  period_end_exclusive: string;
  new_recruitments_count: number;
  stage_transitions_count: number;
}

export async function computeRecruitmentPeriodTransitions(
  scope: RecruitmentScope,
  periodStart: string,
  periodEndExclusive: string,
): Promise<RecruitmentPeriodTransitions> {
  const recruitments = await db
    .select({ id: partnerRecruitmentsTable.id })
    .from(partnerRecruitmentsTable)
    .where(scope.territoryIds ? inArray(partnerRecruitmentsTable.territoryId, scope.territoryIds) : undefined);
  const recruitmentIds = recruitments.map((r) => r.id);

  if (recruitmentIds.length === 0) {
    return { period_start: periodStart, period_end_exclusive: periodEndExclusive, new_recruitments_count: 0, stage_transitions_count: 0 };
  }

  const rangeStart = new Date(periodStart + "T00:00:00.000Z");
  const rangeEndExcl = new Date(periodEndExclusive + "T00:00:00.000Z");
  const historyRowsInRange = await db
    .select({ fromStage: partnerRecruitmentHistoryTable.fromStage, toStage: partnerRecruitmentHistoryTable.toStage })
    .from(partnerRecruitmentHistoryTable)
    .where(
      and(
        inArray(partnerRecruitmentHistoryTable.recruitmentId, recruitmentIds),
        gte(partnerRecruitmentHistoryTable.createdAt, rangeStart),
        lt(partnerRecruitmentHistoryTable.createdAt, rangeEndExcl),
      ),
    );

  // The initial null -> "accepted" row is a creation event, not a
  // transition between two stages -- counted separately as
  // new_recruitments_count, same distinction weeklyReportingService.ts
  // draws for new_candidates_count vs stage_transitions_count.
  const new_recruitments_count = historyRowsInRange.filter((h) => h.fromStage === null).length;
  const stage_transitions_count = historyRowsInRange.filter((h) => h.fromStage !== null && h.fromStage !== h.toStage).length;

  return { period_start: periodStart, period_end_exclusive: periodEndExclusive, new_recruitments_count, stage_transitions_count };
}
