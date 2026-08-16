import React, { useState } from 'react';
import { useGetTerritoryPotential, useListTeamTargets } from '@workspace/api-client-react';
import { TerritoryPotentialCard } from '@/components/territory-potential-card';
import { WorkspaceSubNav } from '@/components/workspace-subnav';
import { REPORTING_SUBNAV_ITEMS } from '@/lib/navigation';
import { PageHeader } from '@/components/page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { getCurrentYear, getCurrentQuarterKey, joinPeriodKey, yearOptions } from '@/lib/period';
import { ChannelPlanSection } from '@/components/channel-plan-section';
import { PamTargetAccordion } from '@/components/pam-target-accordion';

// Phase 11.6C: Reporting's landing surface, rebuilt around the business
// hierarchy ANNUAL TEAM TARGET -> PAM ANNUAL ALLOCATION -> PAM QUARTERLY
// TARGETS -> ACTUAL vs TARGET, replacing the old flat "one row per PAM per
// KPI" table (the "target sausage"). Reuses the existing generic annual-
// target / annual-cascade / team-targets API exactly as before -- no
// migration, no new route (see channel-plan-section.tsx and
// pam-target-accordion.tsx).

type QuarterKey = 'q1' | 'q2' | 'q3' | 'q4';
const QUARTER_OPTIONS: { value: QuarterKey; label: string }[] = [
  { value: 'q1', label: 'Q1' },
  { value: 'q2', label: 'Q2' },
  { value: 'q3', label: 'Q3' },
  { value: 'q4', label: 'Q4' },
];

// getCurrentQuarterKey's return type includes "ytd" for reuse elsewhere
// (see lib/period.ts) but its implementation never actually returns it --
// this narrows defensively rather than casting, with 'q1' as a fallback
// that can never actually trigger.
function currentQuarterFallback(): QuarterKey {
  const q = getCurrentQuarterKey();
  return q === 'q1' || q === 'q2' || q === 'q3' || q === 'q4' ? q : 'q1';
}

export default function TeamTargets() {
  // Annual planning is year-based (see channel-plan-section.tsx) -- this is
  // a genuinely separate selector from `quarter` below, never the combined
  // reporting-period picker other pages use, per the explicit instruction
  // not to confuse the two. "ytd" is never offered here: it is a reporting/
  // actual concept only and is never a stored target period (see
  // lib/db/src/schema/metric_targets.ts), so a quarter-only selector for
  // reviewing actual-vs-target is the honest choice, not merely a smaller
  // one -- selecting "Year to date" in the old flat table's period picker
  // always showed "No target set" for every row anyway, since no target row
  // is ever stored under period="ytd".
  const [year, setYear] = useState(getCurrentYear());
  const [quarter, setQuarter] = useState<QuarterKey>(currentQuarterFallback);

  const { data: territoryPotential, isLoading: potentialLoading } = useGetTerritoryPotential({});
  // Reused only for the existing Territory Potential fact-check below (same
  // computation as before this redesign, now driven by the new quarter
  // selector's derived period instead of the old full PeriodSelector).
  const { data: rows } = useListTeamTargets({ period: joinPeriodKey(year, quarter) as any });

  const targetFactFor = (territoryId: string): string | null => {
    const targetRow = rows?.find((r) => r.territory_id === territoryId && r.metric_key === 'new_partner_prospects' && r.target_value !== null);
    const potential = territoryPotential?.find((t) => t.territory_id === territoryId);
    if (!targetRow || !potential || targetRow.target_value === null) return null;
    if (potential.available_prospect_count >= targetRow.target_value) return null;
    return `Current available qualified pool (${potential.available_prospect_count}) is below the configured target (${targetRow.target_value}) for ${targetRow.metric_label}.`;
  };

  return (
    <div className="p-6 space-y-6">
      <WorkspaceSubNav items={REPORTING_SUBNAV_ITEMS} />
      <PageHeader
        title="Team Targets"
        description="The annual channel plan, allocated across PAMs and quarters."
        actions={
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-[100px] bg-card" data-testid="select-plan-year"><SelectValue /></SelectTrigger>
            <SelectContent>
              {yearOptions().map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        }
      />

      <ChannelPlanSection year={year} />

      <div className="space-y-3 max-w-5xl">
        <div className="flex items-center justify-between">
          <h2 className="text-section-title">Team -- {QUARTER_OPTIONS.find((q) => q.value === quarter)?.label} {year}</h2>
          <Select value={quarter} onValueChange={(v) => setQuarter(v as QuarterKey)}>
            <SelectTrigger className="w-[90px] h-8 bg-card" data-testid="select-review-quarter"><SelectValue /></SelectTrigger>
            <SelectContent>
              {QUARTER_OPTIONS.map((q) => <SelectItem key={q.value} value={q.value}>{q.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          Actual, target, and attainment below are for the selected quarter -- annual allocation totals shown per PAM are for {year} overall.
        </p>
        <PamTargetAccordion year={year} quarter={quarter} />
      </div>

      <div className="space-y-3 max-w-5xl">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Territory Potential</h2>
        {potentialLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : territoryPotential && territoryPotential.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {territoryPotential.map((summary) => (
              <TerritoryPotentialCard key={summary.territory_id} summary={summary} targetFact={targetFactFor(summary.territory_id)} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No territories with an owning PAM yet.</p>
        )}
      </div>
    </div>
  );
}
