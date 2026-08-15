import { Check, Pause, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CANONICAL_STAGE_LABELS, type RecruitmentJourneyModel } from '@/lib/recruitment-journey';

// Phase 11.4: visualizes buildRecruitmentJourney()'s output. Purely
// informational -- there is no click handler anywhere in this file. Stage
// changes only ever happen through the existing explicit action buttons in
// recruitment.tsx (Start outreach / Mark engaged / etc.), never by
// interacting with this component.
interface RecruitmentJourneyProps {
  journey: RecruitmentJourneyModel;
  mode: 'full' | 'compact';
  /** Pre-resolved label (e.g. "No strategic fit") -- this component never guesses a reason. */
  notPursuingReasonLabel?: string | null;
  className?: string;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function RecruitmentJourney({ journey, mode, notPursuingReasonLabel, className }: RecruitmentJourneyProps) {
  if (mode === 'compact') return <CompactJourney journey={journey} className={className} />;
  return <FullJourney journey={journey} notPursuingReasonLabel={notPursuingReasonLabel} className={className} />;
}

function StepMark({ status, terminalStopped }: { status: RecruitmentJourneyModel['steps'][number]['status']; terminalStopped: boolean }) {
  if (terminalStopped) {
    return (
      <div className="h-6 w-6 rounded-full border-2 border-rose-300 bg-rose-50 flex items-center justify-center shrink-0">
        <X className="h-3.5 w-3.5 text-rose-600" />
      </div>
    );
  }
  if (status === 'complete') {
    return (
      <div className="h-6 w-6 rounded-full bg-emerald-600 flex items-center justify-center shrink-0">
        <Check className="h-3.5 w-3.5 text-white" />
      </div>
    );
  }
  if (status === 'current') {
    return (
      <div className="h-6 w-6 rounded-full border-2 border-primary bg-primary/10 flex items-center justify-center shrink-0">
        <div className="h-2 w-2 rounded-full bg-primary" />
      </div>
    );
  }
  return <div className="h-6 w-6 rounded-full border-2 border-border bg-background shrink-0" />;
}

function FullJourney({
  journey,
  notPursuingReasonLabel,
  className,
}: {
  journey: RecruitmentJourneyModel;
  notPursuingReasonLabel?: string | null;
  className?: string;
}) {
  const { steps, holdActive, notPursuing, effectiveStage } = journey;

  return (
    <div className={cn('space-y-3', className)}>
      {effectiveStage === null ? (
        <p className="text-sm text-muted-foreground">Stage history isn't available for this recruitment.</p>
      ) : (
        // Always horizontal: the containers this renders in (a ~400px
        // detail drawer) are a fixed width regardless of viewport, so a
        // viewport-width breakpoint would solve the wrong problem -- each
        // column instead gets an equal flex-1 share with min-w-0, and
        // labels are allowed to wrap to 2 lines rather than force overflow.
        <div className="flex items-start gap-0">
          {steps.map((step, index) => {
            // The stopped-at step under not_pursuing is marked distinctly
            // (an X, not a checkmark) -- everything before it genuinely
            // happened, so it still reads as complete, but the step itself
            // must not look like ordinary progress.
            const terminalStopped = notPursuing && step.status === 'current';
            const date = formatDate(step.enteredAt);
            return (
              <div key={step.stage} className="flex-1 min-w-0 flex flex-col items-center gap-1.5">
                <div className="flex w-full items-center">
                  <div className={cn('flex-1 h-px', index === 0 ? 'opacity-0' : step.status === 'upcoming' ? 'bg-border' : 'bg-emerald-600')} />
                  <StepMark status={step.status} terminalStopped={terminalStopped} />
                  <div className={cn('flex-1 h-px', index === steps.length - 1 ? 'opacity-0' : step.status === 'complete' ? 'bg-emerald-600' : 'bg-border')} />
                </div>
                <div className="text-center px-0.5">
                  <p className={cn('text-[11px] font-medium leading-tight', step.status === 'upcoming' ? 'text-muted-foreground' : 'text-foreground')}>
                    {CANONICAL_STAGE_LABELS[step.stage]}
                  </p>
                  {date && <p className="text-[10px] text-muted-foreground tabular-nums leading-tight">{date}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {holdActive && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <Pause className="h-3.5 w-3.5 shrink-0" />
          <span>
            On hold{effectiveStage ? <> from {CANONICAL_STAGE_LABELS[effectiveStage]}</> : null} since {formatDate(journey.currentStatusSince)}.
          </span>
        </div>
      )}

      {notPursuing && (
        <div className="flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <X className="h-3.5 w-3.5 shrink-0" />
          <span>
            Not pursuing since {formatDate(journey.currentStatusSince)}
            {notPursuingReasonLabel ? <> — {notPursuingReasonLabel}</> : null}.
          </span>
        </div>
      )}
    </div>
  );
}

function CompactJourney({ journey, className }: { journey: RecruitmentJourneyModel; className?: string }) {
  const { steps, holdActive, notPursuing, effectiveStage } = journey;

  const summary = notPursuing
    ? `Not pursuing${effectiveStage ? ` (reached ${CANONICAL_STAGE_LABELS[effectiveStage]})` : ''}`
    : holdActive
      ? `On hold${effectiveStage ? ` at ${CANONICAL_STAGE_LABELS[effectiveStage]}` : ''}`
      : effectiveStage === 'signed'
        ? `Signed via Recruitment${journey.currentStatusSince ? ` · ${formatDate(journey.currentStatusSince)}` : ''}`
        : effectiveStage
          ? `Recruitment: ${CANONICAL_STAGE_LABELS[effectiveStage]}`
          : 'Recruitment history unavailable';

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="flex items-center gap-0.5">
        {steps.map((step) => {
          const terminalStopped = notPursuing && step.status === 'current';
          const dotClass = terminalStopped
            ? 'bg-rose-400'
            : step.status === 'complete'
              ? 'bg-emerald-600'
              : step.status === 'current'
                ? 'bg-primary'
                : 'bg-border';
          return <div key={step.stage} className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />;
        })}
      </div>
      <span className="text-xs text-muted-foreground">{summary}</span>
    </div>
  );
}
