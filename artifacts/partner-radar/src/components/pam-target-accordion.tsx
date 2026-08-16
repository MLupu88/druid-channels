import React, { useMemo, useState } from 'react';
import { useListTeamTargets } from '@workspace/api-client-react';
import type { TeamTargetRow } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetAnnualCascadeQueryKey, getListTeamTargetsQueryKey } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { SectionCard } from '@/components/section-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Users, Pencil } from 'lucide-react';
import { statusTone } from '@/lib/status-tone';
import { formatUsd, formatCount, isMoneyMetric } from '@/lib/kpi-format';
import { joinPeriodKey } from '@/lib/period';
import { PRIMARY_PLAN_METRICS, SECONDARY_PLAN_METRICS, useMetricCascade, AllocateAnnualTargetDialog, type PlanMetricDef } from '@/components/channel-plan-section';

// Phase 11.6C: PAM-grouped replacement for the old flat PAM x KPI table
// (one row per PAM, expandable into commercial / partner-development /
// quarterly-allocation groups) -- reads GET /team-targets (unchanged,
// self-scoping already enforced server-side, see targetService.ts) for
// this-quarter target/actual/attainment, and reuses useMetricCascade +
// AllocateAnnualTargetDialog from channel-plan-section.tsx for each PAM's
// annual allocation total and quarterly edit affordance, rather than
// duplicating either.

type QuarterKey = 'q1' | 'q2' | 'q3' | 'q4';
const QUARTERS: QuarterKey[] = ['q1', 'q2', 'q3', 'q4'];

function fmtMetric(value: number | null | undefined, metricKey: string): string {
  if (value === null || value === undefined) return '--';
  return isMoneyMetric(metricKey) ? formatUsd(value) : formatCount(value);
}

function QuarterStatusBadge({ row }: { row: TeamTargetRow | undefined }) {
  if (!row || row.status === 'no_target') {
    return <Badge variant="outline" className="font-normal text-muted-foreground">No target</Badge>;
  }
  const tone = row.status === 'ahead' ? statusTone('success') : statusTone('warning');
  const label = row.status === 'ahead' ? 'Ahead' : 'Behind';
  return (
    <Badge variant="outline" className={`font-normal ${tone}`}>
      {row.progress_percent !== null ? `${row.progress_percent}%` : '--'} &middot; {label}
    </Badge>
  );
}

interface PamGroup {
  pam_user_id: string;
  pam_name: string;
  territory_id: string;
  territory_name: string;
  rowsByMetric: Map<string, TeamTargetRow>;
}

function annualAllocationTotal(
  metricKey: string,
  pam: { pam_user_id: string; territory_id: string },
  cascadeByMetric: Record<string, ReturnType<typeof useMetricCascade>['data']>,
): number | null {
  const allocation = cascadeByMetric[metricKey]?.allocations.find(
    (a) => a.pam_user_id === pam.pam_user_id && a.territory_id === pam.territory_id,
  );
  if (!allocation) return null;
  // A PAM with no allocation rows at all for this metric (never opened
  // "Allocate") is distinct from a PAM with an explicit 0 -- but since
  // every quarter here is independently nullable, "nothing entered in any
  // quarter" and "an explicit 0 in every quarter" are presentationally the
  // same "0" total either way; the per-quarter breakdown below is where
  // an individual unset quarter still shows as "--", never a fabricated 0.
  if (allocation.q1 === null && allocation.q2 === null && allocation.q3 === null && allocation.q4 === null) return null;
  return (allocation.q1 ?? 0) + (allocation.q2 ?? 0) + (allocation.q3 ?? 0) + (allocation.q4 ?? 0);
}

function CommercialMetricLine({ metric, row, annualTotal }: { metric: PlanMetricDef; row: TeamTargetRow | undefined; annualTotal: number | null }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <p className="text-xs font-medium text-foreground mb-2">{metric.label}</p>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">This quarter</p>
          <p className="tabular-nums">
            {row?.actual_value === null || row?.actual_value === undefined ? '--' : fmtMetric(row.actual_value, metric.key)}
            <span className="text-muted-foreground"> / {row?.target_value === null || row?.target_value === undefined ? 'not set' : fmtMetric(row.target_value, metric.key)}</span>
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Annual allocation</p>
          <p className="tabular-nums">{annualTotal === null ? 'Not set' : fmtMetric(annualTotal, metric.key)}</p>
        </div>
      </div>
      <div className="mt-1.5"><QuarterStatusBadge row={row} /></div>
    </div>
  );
}

function PartnerDevMetricLine({ metric, row }: { metric: PlanMetricDef; row: TeamTargetRow | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm py-1.5">
      <span className="text-muted-foreground">{metric.label}</span>
      <span className="tabular-nums">
        {fmtMetric(row?.actual_value, metric.key)}
        <span className="text-muted-foreground"> / {row?.target_value === null || row?.target_value === undefined ? 'not set' : fmtMetric(row.target_value, metric.key)}</span>
      </span>
    </div>
  );
}

export function PamTargetAccordion({ year, quarter }: { year: number; quarter: QuarterKey }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const period = joinPeriodKey(year, quarter) as any;
  const { data: teamTargetRows, isLoading } = useListTeamTargets({ period });

  // Fixed, explicit calls -- same convention as channel-plan-section.tsx,
  // never a hook inside a loop. Needed here only for each PAM's annual
  // allocation total (the this-quarter target/actual above comes from
  // teamTargetRows, not these).
  const closedRevenue = useMetricCascade('closed_revenue', year);
  const sourcedPipeline = useMetricCascade('partner_sourced_pipeline', year);
  const influencedPipeline = useMetricCascade('partner_influenced_pipeline', year);
  const cascadeByMetric = {
    closed_revenue: closedRevenue.data,
    partner_sourced_pipeline: sourcedPipeline.data,
    partner_influenced_pipeline: influencedPipeline.data,
  };

  const [allocatingMetric, setAllocatingMetric] = useState<PlanMetricDef | null>(null);

  const pamGroups: PamGroup[] = useMemo(() => {
    const map = new Map<string, PamGroup>();
    for (const row of teamTargetRows ?? []) {
      const key = `${row.pam_user_id}-${row.territory_id}`;
      let group = map.get(key);
      if (!group) {
        group = { pam_user_id: row.pam_user_id, pam_name: row.pam_name, territory_id: row.territory_id, territory_name: row.territory_name, rowsByMetric: new Map() };
        map.set(key, group);
      }
      group.rowsByMetric.set(row.metric_key, row);
    }
    return [...map.values()].sort((a, b) => a.pam_name.localeCompare(b.pam_name) || a.territory_name.localeCompare(b.territory_name));
  }, [teamTargetRows]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAnnualCascadeQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTeamTargetsQueryKey() });
  };

  if (isLoading) {
    return <Skeleton className="h-[280px] w-full rounded-md max-w-5xl" />;
  }

  if (pamGroups.length === 0) {
    return (
      <SectionCard className="max-w-5xl">
        <Empty className="border-none py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Users /></EmptyMedia>
            <EmptyTitle>No PAMs own a territory yet</EmptyTitle>
            <EmptyDescription>Assign one from Settings &gt; Team.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SectionCard>
    );
  }

  return (
    <div className="max-w-5xl" data-testid="section-pam-target-accordion">
      <SectionCard>
        <Accordion type="multiple" className="px-2">
          {pamGroups.map((pam) => {
            const closedRevenueRow = pam.rowsByMetric.get('closed_revenue');
            const sourcedRow = pam.rowsByMetric.get('partner_sourced_pipeline');
            const influencedRow = pam.rowsByMetric.get('partner_influenced_pipeline');
            const signedRow = pam.rowsByMetric.get('signed_partners');
            const prospectsRow = pam.rowsByMetric.get('new_partner_prospects');

            return (
              <AccordionItem key={`${pam.pam_user_id}-${pam.territory_id}`} value={`${pam.pam_user_id}-${pam.territory_id}`} className="border-b last:border-b-0">
                <AccordionTrigger className="hover:no-underline px-2" data-testid={`trigger-pam-${pam.pam_user_id}`}>
                  <div className="flex items-center justify-between gap-4 w-full pr-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="text-left min-w-0">
                        <p className="font-medium truncate">{pam.pam_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{pam.territory_name}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 shrink-0 text-sm">
                      <div className="text-right hidden sm:block">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Closed revenue</p>
                        <p className="tabular-nums">
                          {fmtMetric(closedRevenueRow?.actual_value, 'closed_revenue')}
                          <span className="text-muted-foreground"> / {closedRevenueRow?.target_value === null || closedRevenueRow?.target_value === undefined ? 'not set' : fmtMetric(closedRevenueRow.target_value, 'closed_revenue')}</span>
                        </p>
                      </div>
                      <div className="text-right hidden md:block">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Pipeline (S / I)</p>
                        <p className="tabular-nums">{fmtMetric(sourcedRow?.actual_value, 'partner_sourced_pipeline')} / {fmtMetric(influencedRow?.actual_value, 'partner_influenced_pipeline')}</p>
                      </div>
                      <QuarterStatusBadge row={closedRevenueRow} />
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-2 space-y-4">
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Commercial</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <CommercialMetricLine metric={PRIMARY_PLAN_METRICS[0]} row={closedRevenueRow} annualTotal={annualAllocationTotal('closed_revenue', pam, cascadeByMetric)} />
                      <CommercialMetricLine metric={PRIMARY_PLAN_METRICS[1]} row={sourcedRow} annualTotal={annualAllocationTotal('partner_sourced_pipeline', pam, cascadeByMetric)} />
                      <CommercialMetricLine metric={PRIMARY_PLAN_METRICS[2]} row={influencedRow} annualTotal={annualAllocationTotal('partner_influenced_pipeline', pam, cascadeByMetric)} />
                    </div>
                  </div>

                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Partner development</h4>
                    <div className="rounded-md border border-border/60 px-3 divide-y divide-border/50">
                      <PartnerDevMetricLine metric={SECONDARY_PLAN_METRICS[0]} row={signedRow} />
                      <PartnerDevMetricLine metric={SECONDARY_PLAN_METRICS[1]} row={prospectsRow} />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Quarterly allocation</h4>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setAllocatingMetric(PRIMARY_PLAN_METRICS[0])} data-testid={`button-edit-quarters-${pam.pam_user_id}`}>
                        <Pencil className="h-3 w-3 mr-1" />
                        Edit
                      </Button>
                    </div>
                    <div className="rounded-md border border-border/60 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/20 text-xs text-muted-foreground">
                            <th className="text-left font-medium px-3 py-1.5">Metric</th>
                            {QUARTERS.map((q) => <th key={q} className="text-right font-medium px-3 py-1.5">{q.toUpperCase()}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {PRIMARY_PLAN_METRICS.map((metric) => {
                            const allocation = cascadeByMetric[metric.key as keyof typeof cascadeByMetric]?.allocations.find(
                              (a) => a.pam_user_id === pam.pam_user_id && a.territory_id === pam.territory_id,
                            );
                            return (
                              <tr key={metric.key} className="border-t border-border/50">
                                <td className="px-3 py-1.5 text-muted-foreground">{metric.label}</td>
                                {QUARTERS.map((q) => (
                                  <td key={q} className="px-3 py-1.5 text-right tabular-nums">
                                    {allocation?.[q] === null || allocation?.[q] === undefined ? '--' : fmtMetric(allocation[q], metric.key)}
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </SectionCard>

      {allocatingMetric && (
        <AllocateAnnualTargetDialog
          year={year}
          metricKey={allocatingMetric.key}
          metricLabel={allocatingMetric.label}
          isMoney={allocatingMetric.isMoney}
          annualTarget={cascadeByMetric[allocatingMetric.key as keyof typeof cascadeByMetric]?.annual_target ?? null}
          allocations={cascadeByMetric[allocatingMetric.key as keyof typeof cascadeByMetric]?.allocations ?? []}
          onClose={() => setAllocatingMetric(null)}
          onSaved={() => { invalidate(); setAllocatingMetric(null); toast({ title: 'Allocation saved' }); }}
        />
      )}
    </div>
  );
}
