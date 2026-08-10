import { db } from "@workspace/db";
import {
  partnerRecruitmentsTable,
  partnerRecruitmentHistoryTable,
  type PartnerRecruitment,
  RECRUITMENT_STAGES,
  NOT_PURSUING_REASONS,
} from "@workspace/db";
import { eq } from "drizzle-orm";

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

    return updated!;
  });
}
