// Phase 11.4: pure derivation of "where is this recruitment in the
// canonical funnel" from the exact stored stage/history -- no new stages,
// no fabricated dates. This is the single source for the canonical linear
// order (previously duplicated as recruitment.tsx's own SUMMARY_STAGES).
//
// on_hold and not_pursuing are exception states layered on top of the
// linear funnel, not steps within it (see partner_recruitments.ts's own
// schema comments): a recruitment's `previous_stage` column is ONLY ever
// meaningful while stage === 'on_hold' (cleared the moment it resumes), so
// it is never used here to place a not_pursuing recruitment -- that comes
// from the append-only history's `from_stage` on the row that transitioned
// to not_pursuing instead, which is the actual source of truth for "how
// far did this get before it stopped."
export type CanonicalRecruitmentStage = 'accepted' | 'contacting' | 'engaged' | 'agreement' | 'signed';

export const CANONICAL_RECRUITMENT_STAGES: readonly CanonicalRecruitmentStage[] = [
  'accepted',
  'contacting',
  'engaged',
  'agreement',
  'signed',
];

// Single source for the 5 canonical stage labels -- recruitment.tsx's own
// STAGE_LABELS (which also covers on_hold/not_pursuing, not part of this
// linear model) spreads this in rather than repeating the 5 strings.
export const CANONICAL_STAGE_LABELS: Record<CanonicalRecruitmentStage, string> = {
  accepted: 'Accepted',
  contacting: 'Contacting',
  engaged: 'Engaged',
  agreement: 'Agreement',
  signed: 'Signed',
};

function isCanonicalStage(stage: string | null | undefined): stage is CanonicalRecruitmentStage {
  return !!stage && (CANONICAL_RECRUITMENT_STAGES as readonly string[]).includes(stage);
}

export type RecruitmentJourneyStepStatus = 'complete' | 'current' | 'upcoming';

export interface RecruitmentJourneyStep {
  stage: CanonicalRecruitmentStage;
  status: RecruitmentJourneyStepStatus;
  /** ISO timestamp this stage was (most recently) entered, from history. Null when history doesn't establish it -- never guessed. */
  enteredAt: string | null;
}

export interface RecruitmentJourneyHistoryEntry {
  from_stage?: string | null;
  to_stage: string;
  created_at: string;
}

export interface RecruitmentJourneyInput {
  stage: string;
  previous_stage?: string | null;
  stage_entered_at: string;
  history?: RecruitmentJourneyHistoryEntry[] | null;
}

export interface RecruitmentJourneyModel {
  steps: RecruitmentJourneyStep[];
  /** The canonical stage this recruitment has reached (or is paused/stopped at). Null only when history can't establish one -- e.g. on_hold/not_pursuing with no usable history. */
  effectiveStage: CanonicalRecruitmentStage | null;
  holdActive: boolean;
  notPursuing: boolean;
  /** stage_entered_at verbatim -- when the CURRENT stored stage (including on_hold/not_pursuing itself) began. */
  currentStatusSince: string;
}

// Walks history backward from the end, skipping on_hold hops, to find the
// last canonical stage actually reached. Used only for on_hold/not_pursuing,
// where `stage` itself isn't a canonical funnel position.
function findLastCanonicalStageFromHistory(history: RecruitmentJourneyHistoryEntry[]): CanonicalRecruitmentStage | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (isCanonicalStage(entry.to_stage)) return entry.to_stage;
    if (isCanonicalStage(entry.from_stage)) return entry.from_stage;
  }
  return null;
}

export function buildRecruitmentJourney(input: RecruitmentJourneyInput): RecruitmentJourneyModel {
  const history = input.history ?? [];
  const holdActive = input.stage === 'on_hold';
  const notPursuing = input.stage === 'not_pursuing';

  let effectiveStage: CanonicalRecruitmentStage | null;
  if (isCanonicalStage(input.stage)) {
    effectiveStage = input.stage;
  } else if (holdActive && isCanonicalStage(input.previous_stage)) {
    // previous_stage is authoritative for on_hold specifically (see module
    // comment) -- prefer it over a history scan when present.
    effectiveStage = input.previous_stage;
  } else {
    effectiveStage = findLastCanonicalStageFromHistory(history);
  }

  // Latest entry into each canonical stage, from real history rows only.
  // Forward iteration + overwrite means a stage re-entered after a hold
  // shows its most recent entry date, not its first.
  const enteredAtByStage = new Map<CanonicalRecruitmentStage, string>();
  for (const entry of history) {
    if (isCanonicalStage(entry.to_stage)) {
      enteredAtByStage.set(entry.to_stage, entry.created_at);
    }
  }
  // The current canonical stage's own stage_entered_at is authoritative
  // (always fresh, even if history is incomplete) -- prefer it.
  if (isCanonicalStage(input.stage) && effectiveStage === input.stage) {
    enteredAtByStage.set(input.stage, input.stage_entered_at);
  }

  const effectiveIndex = effectiveStage ? CANONICAL_RECRUITMENT_STAGES.indexOf(effectiveStage) : -1;

  const steps: RecruitmentJourneyStep[] = CANONICAL_RECRUITMENT_STAGES.map((stage, index) => {
    let status: RecruitmentJourneyStepStatus;
    if (effectiveIndex === -1) {
      status = 'upcoming'; // truly undeterminable -- no fabricated progress
    } else if (index < effectiveIndex) {
      status = 'complete';
    } else if (index === effectiveIndex) {
      status = 'current';
    } else {
      status = 'upcoming';
    }
    return { stage, status, enteredAt: enteredAtByStage.get(stage) ?? null };
  });

  return { steps, effectiveStage, holdActive, notPursuing, currentStatusSince: input.stage_entered_at };
}
