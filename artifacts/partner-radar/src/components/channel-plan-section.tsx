import React, { useState } from 'react';
import {
  useGetAnnualCascade,
  getGetAnnualCascadeQueryKey,
  useUpsertMetricTarget,
  getListTeamTargetsQueryKey,
  useListMetricMappings,
} from '@workspace/api-client-react';
import type { AnnualCascade, PamAllocation } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { SectionCard, SectionCardHeader, SectionCardContent } from '@/components/section-card';
import { MetricTile } from '@/components/metric-tile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Pencil, AlertTriangle, Split } from 'lucide-react';
import { EditAnnualTargetDialog } from '@/components/commercial-performance';
import { deriveAllocationStatus } from '@/lib/commercial-cascade';
import { formatUsd, formatCount } from '@/lib/kpi-format';
import { joinPeriodKey } from '@/lib/period';
import { splitMoneyEvenly, splitCountEvenly } from '@/lib/split-evenly';

// Phase 11.6C: the Reporting/Team Targets "top of page" management section
// -- the externalized annual team plan for all 5 targetable metrics,
// money-first. Deliberately reuses the existing generic annual-target /
// annual-cascade API exactly as-is (GET/PUT /metric-targets/annual, GET
// /metric-targets/annual-cascade already accept an arbitrary metric_key --
// see targetService.ts, untouched by this slice): no migration, no new
// route. commercial-performance.tsx's Overview section stays closed_revenue
// -only and untouched; this is an independent, additive consumer of the
// same backend.

export interface PlanMetricDef {
  key: string;
  label: string;
  isMoney: boolean;
}

// Money first, by construction -- this order drives both the visual
// hierarchy below (Closed Revenue featured, pipeline next, partner counts
// quietest) and is never re-sorted by any runtime value.
export const PRIMARY_PLAN_METRICS: PlanMetricDef[] = [
  { key: 'closed_revenue', label: 'Closed Revenue', isMoney: true },
  { key: 'partner_sourced_pipeline', label: 'Partner-Sourced Pipeline', isMoney: true },
  { key: 'partner_influenced_pipeline', label: 'Partner-Influenced Pipeline', isMoney: true },
];
export const SECONDARY_PLAN_METRICS: PlanMetricDef[] = [
  { key: 'signed_partners', label: 'Signed Partners', isMoney: false },
  { key: 'new_partner_prospects', label: 'New Partner Prospects', isMoney: false },
];
export const ALL_PLAN_METRICS: PlanMetricDef[] = [...PRIMARY_PLAN_METRICS, ...SECONDARY_PLAN_METRICS];

function formatPlanValue(value: number | null | undefined, isMoney: boolean): string {
  if (value === null || value === undefined) return '--';
  return isMoney ? formatUsd(value) : formatCount(value);
}

// Thin wrapper so every metric's cascade query shares the exact same
// queryKey shape react-query already uses elsewhere in this app --
// identical params from PamTargetAccordion (same metric_key/year) hit the
// same cache entry, never a second network request.
export function useMetricCascade(metricKey: string, year: number) {
  const params = { metric_key: metricKey, year };
  return useGetAnnualCascade(params, { query: { queryKey: getGetAnnualCascadeQueryKey(params) } });
}

// ---- provenance (metric-level -- verified incapable of a mixed-territory
// misrepresentation, see 11.6C amendment note below) -------------------------
//
// GET /metric-mappings (admin-only, same as this whole route) reports
// current_data_status per metric_key globally. This is not a design choice
// to simplify a real per-territory signal down to one badge -- there is no
// per-territory (or per-PAM) data-status concept ANYWHERE in this API to
// simplify away:
//   - metric_mappings (lib/db/src/schema/metric_mappings.ts) has a hard
//     `.unique()` constraint on metric_key alone and no territory column at
//     all -- it is structurally impossible for two territories to have
//     different mapping rows for the same metric.
//   - routes/metric_mappings.ts's GET handler computes current_data_status
//     via `computeMetric(def.key, resolvePeriodKey(null), await
//     resolveTerritory(null))` -- territory is explicitly null (global
//     scope), computed exactly once per metric, never once per territory.
// So "one territory CONNECTED, another MANUAL, badge shows a single
// CONNECTED" cannot occur: the API itself never produces more than one
// status value per metric to begin with. This badge is also only ever
// attached to the Channel Plan's cascade figures (annual_target/actual),
// which are themselves company-wide aggregates, not territory-scoped --
// so the badge's granularity always matches the figure it's next to.
//
// Quiet by default: renders nothing at all when the metric is healthily
// CONNECTED, per "do not make the page noisy with provenance on every
// number" -- only speaks up for MANUAL/DEMO/NOT_CONNECTED.
function MetricDataStatusBadge({ status }: { status: string | undefined }) {
  if (!status || status === 'CONNECTED') return null;
  if (status === 'MANUAL') return <Badge variant="outline" className="text-sky-700 bg-sky-50 border-sky-200 font-normal text-[10px]">Manual</Badge>;
  if (status === 'DEMO') return <Badge variant="outline" className="text-attention bg-attention/10 border-attention-border font-normal text-[10px]">Demo data</Badge>;
  return <Badge variant="outline" className="text-muted-foreground font-normal text-[10px]">Not connected</Badge>;
}

function AllocationStatusBadge({ status }: { status: ReturnType<typeof deriveAllocationStatus> }) {
  if (status === 'overallocated') return <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal">Overallocated</Badge>;
  if (status === 'underallocated') return <Badge variant="outline" className="text-attention bg-attention/10 border-attention-border font-normal">Underallocated</Badge>;
  if (status === 'exact') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal">Fully allocated</Badge>;
  // 'no_target': deriveAllocationStatus (lib/commercial-cascade.ts, untouched)
  // only ever returns this when annual_target is null -- a missing target
  // reads as neutral here, never as an implicit zero.
  return <Badge variant="outline" className="text-muted-foreground font-normal">No target set</Badge>;
}

function PlanMetricCard({
  metric,
  cascade,
  isLoading,
  dataStatus,
  featured,
  onEditTarget,
  onManageAllocation,
}: {
  metric: PlanMetricDef;
  cascade: AnnualCascade | undefined;
  isLoading: boolean;
  dataStatus: string | undefined;
  featured?: boolean;
  onEditTarget: () => void;
  onManageAllocation: () => void;
}) {
  if (isLoading || !cascade) {
    return (
      <SectionCard>
        <SectionCardContent>
          <Skeleton className={featured ? 'h-28 w-full' : 'h-24 w-full'} />
        </SectionCardContent>
      </SectionCard>
    );
  }

  const allocationStatus = deriveAllocationStatus(cascade);
  const fmt = (v: number | null) => formatPlanValue(v, metric.isMoney);
  const tileVariant = featured ? 'primary' : 'default';

  return (
    <SectionCard data-testid={`card-plan-metric-${metric.key}`}>
      <SectionCardHeader
        title={
          <span className="flex items-center gap-2">
            {metric.label}
            <MetricDataStatusBadge status={dataStatus} />
          </span>
        }
        actions={
          <Button variant="ghost" size="sm" onClick={onEditTarget} data-testid={`button-edit-target-${metric.key}`}>
            <Pencil className="h-3.5 w-3.5 mr-1.5" />
            {cascade.annual_target === null ? 'Set target' : 'Edit target'}
          </Button>
        }
      />
      <SectionCardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          {/* "Not set" is the only value ever shown for a missing target --
              never a fabricated 0 -- see deriveAllocationStatus's own
              no_target handling and the PlanMetricCard-level test coverage. */}
          <MetricTile label="Annual target" value={cascade.annual_target === null ? 'Not set' : fmt(cascade.annual_target)} variant={tileVariant} />
          <MetricTile label="Actual (YTD)" value={fmt(cascade.actual)} variant={tileVariant} />
          <MetricTile
            label="Attainment"
            value={cascade.attainment_percent === null ? '--' : `${cascade.attainment_percent}%`}
            variant={tileVariant}
            attention={cascade.attainment_percent !== null && cascade.attainment_percent < 70}
          />
        </div>
        {cascade.attainment_percent !== null && <Progress value={Math.min(100, cascade.attainment_percent)} className="h-1.5" />}
        <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
          <AllocationStatusBadge status={allocationStatus} />
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onManageAllocation} data-testid={`button-manage-allocation-${metric.key}`}>
            Manage allocation
          </Button>
        </div>
      </SectionCardContent>
    </SectionCard>
  );
}

// ---- Allocate annual target (Split evenly) ---------------------------------

type AllocationQuarterKey = 'q1' | 'q2' | 'q3' | 'q4';
const QUARTERS: AllocationQuarterKey[] = ['q1', 'q2', 'q3', 'q4'];
const QUARTER_LABEL: Record<AllocationQuarterKey, string> = { q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4' };

function allocationKey(a: { pam_user_id: string; territory_id: string }): string {
  return `${a.pam_user_id}-${a.territory_id}`;
}

export function AllocateAnnualTargetDialog({
  year,
  metricKey,
  metricLabel,
  isMoney,
  annualTarget,
  allocations,
  onClose,
  onSaved,
}: {
  year: number;
  metricKey: string;
  metricLabel: string;
  isMoney: boolean;
  annualTarget: number | null;
  allocations: PamAllocation[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();

  // Deterministic order -- alphabetical by PAM, then territory -- so both
  // "Split evenly"'s rounding remainder and the table's own row order are
  // stable and predictable, never incidental to API response order.
  const [sortedAllocations] = useState(() =>
    [...allocations].sort((a, b) => a.pam_name.localeCompare(b.pam_name) || a.territory_name.localeCompare(b.territory_name)),
  );

  const [values, setValues] = useState<Record<string, Record<AllocationQuarterKey, string>>>(() => {
    const initial: Record<string, Record<AllocationQuarterKey, string>> = {};
    for (const a of sortedAllocations) {
      initial[allocationKey(a)] = {
        q1: a.q1 !== null ? String(a.q1) : '',
        q2: a.q2 !== null ? String(a.q2) : '',
        q3: a.q3 !== null ? String(a.q3) : '',
        q4: a.q4 !== null ? String(a.q4) : '',
      };
    }
    return initial;
  });

  const upsertMutation = useUpsertMetricTarget();
  const [isSaving, setIsSaving] = useState(false);

  const setCell = (key: string, quarter: AllocationQuarterKey, raw: string) => {
    setValues((prev) => ({ ...prev, [key]: { ...prev[key], [quarter]: raw } }));
  };

  // "Split evenly": only ever rewrites local component state (setValues) --
  // never calls a mutation, never saves anything by itself. The user still
  // has to review the prefilled table and press Save below.
  //
  // Two-level split: the annual target is divided evenly across PAMs first,
  // then each PAM's own share is divided evenly across its 4 quarters.
  //
  // Precision fix (11.6C amendment): money metrics keep full currency
  // precision -- splitMoneyEvenly (lib/split-evenly.ts) splits in integer
  // CENTS, never whole dollars, so an annual target like $100.01 reconciles
  // to exactly $100.01 across PAMs/quarters instead of being silently
  // rounded to $100 the moment Split Evenly is clicked. Count metrics use
  // splitCountEvenly (whole units -- a partner can never be split into a
  // fraction of one). Both levels reuse the same deterministic
  // integer-remainder rule either way, so the team's grand total always
  // reconciles exactly, never an approximation that silently drifts.
  const handleSplitEvenly = () => {
    if (annualTarget === null || sortedAllocations.length === 0) return;
    const splitFn = isMoney ? splitMoneyEvenly : splitCountEvenly;
    const formatShare = (v: number) => (isMoney ? v.toFixed(2) : String(v));
    const perPam = splitFn(annualTarget, sortedAllocations.length);
    const next: typeof values = {};
    sortedAllocations.forEach((a, i) => {
      const [q1, q2, q3, q4] = splitFn(perPam[i], 4);
      next[allocationKey(a)] = { q1: formatShare(q1), q2: formatShare(q2), q3: formatShare(q3), q4: formatShare(q4) };
    });
    setValues(next);
  };

  // Live, client-side-only preview of the same allocated/unallocated/
  // overallocated arithmetic computeAnnualCascade performs server-side (see
  // targetService.ts, untouched) -- recomputed here purely for instant
  // feedback while the user is still typing/reviewing, before anything is
  // saved. The authoritative numbers always come from a fresh GET
  // /metric-targets/annual-cascade after Save (see onSaved's invalidation);
  // this preview is never written anywhere and never substitutes for that
  // refetch.
  const currentTotal = sortedAllocations.reduce((sum, a) => {
    const cell = values[allocationKey(a)];
    return sum + QUARTERS.reduce((qSum, q) => qSum + (cell[q].trim() === '' ? 0 : Number(cell[q]) || 0), 0);
  }, 0);
  const previewUnallocated = annualTarget !== null ? Math.max(0, annualTarget - currentTotal) : null;
  const previewOverallocated = Math.max(0, currentTotal - (annualTarget ?? 0));

  const hasInvalid = sortedAllocations.some((a) => {
    const cell = values[allocationKey(a)];
    return QUARTERS.some((q) => {
      if (cell[q].trim() === '') return false;
      const n = Number(cell[q]);
      return !Number.isFinite(n) || n < 0 || (!isMoney && !Number.isInteger(n));
    });
  });

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const writes: Array<{ territoryId: string; pamUserId: string; quarter: AllocationQuarterKey; value: number }> = [];
      for (const a of sortedAllocations) {
        const cell = values[allocationKey(a)];
        for (const q of QUARTERS) {
          // Only quarters actually entered are saved -- an empty field is
          // left unset rather than written as a fabricated 0, same
          // convention as commercial-performance.tsx's EditAllocationDialog.
          if (cell[q].trim() === '') continue;
          writes.push({ territoryId: a.territory_id, pamUserId: a.pam_user_id, quarter: q, value: Number(cell[q]) });
        }
      }
      await Promise.all(
        writes.map((w) =>
          upsertMutation.mutateAsync({
            data: {
              metric_key: metricKey,
              period: joinPeriodKey(year, w.quarter) as any,
              territory_id: w.territoryId,
              pam_user_id: w.pamUserId,
              target_value: w.value,
              note: null,
            },
          }),
        ),
      );
      onSaved();
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Could not save allocation', description: err?.message ?? 'Please try again.' });
    } finally {
      setIsSaving(false);
    }
  };

  const fmt = (v: number) => (isMoney ? formatUsd(v) : formatCount(v));

  return (
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Allocate {metricLabel} -- {year}</DialogTitle>
          <DialogDescription>
            Split the annual target across PAMs and quarters. Nothing is saved until you press Save.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground">
            Annual target: <span className="font-medium text-foreground">{annualTarget === null ? 'Not set' : fmt(annualTarget)}</span>
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSplitEvenly}
            disabled={annualTarget === null || sortedAllocations.length === 0}
            data-testid="button-split-evenly"
          >
            <Split className="h-3.5 w-3.5 mr-1.5" />
            Split evenly
          </Button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto border border-border/60 rounded-md">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>PAM</TableHead>
                <TableHead>Territory</TableHead>
                {QUARTERS.map((q) => (
                  <TableHead key={q} className="text-right w-[100px]">{QUARTER_LABEL[q]}</TableHead>
                ))}
                <TableHead className="text-right w-[110px]">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedAllocations.length > 0 ? (
                sortedAllocations.map((a) => {
                  const key = allocationKey(a);
                  const cell = values[key];
                  const rowTotal = QUARTERS.reduce((sum, q) => sum + (cell[q].trim() === '' ? 0 : Number(cell[q]) || 0), 0);
                  return (
                    <TableRow key={key}>
                      <TableCell className="font-medium">{a.pam_name}</TableCell>
                      <TableCell className="text-muted-foreground">{a.territory_name}</TableCell>
                      {QUARTERS.map((q) => (
                        <TableCell key={q} className="text-right">
                          <Input
                            type="number"
                            min="0"
                            step={isMoney ? 'any' : 1}
                            value={cell[q]}
                            onChange={(e) => setCell(key, q, e.target.value)}
                            className="h-8 text-right"
                            data-testid={`input-allocate-${key}-${q}`}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="text-right tabular-nums font-medium">{fmt(rowTotal)}</TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                    No PAMs own a territory yet -- assign one from Settings &gt; Team.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="rounded-md border border-border/60 p-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">
            Total allocated: <span className="text-foreground font-medium tabular-nums">{fmt(currentTotal)}</span>
          </span>
          {annualTarget === null ? (
            <span className="text-muted-foreground">Set an annual target to see unallocated/overallocated amounts.</span>
          ) : previewOverallocated > 0 ? (
            <span className="flex items-center gap-1.5 text-rose-700 font-medium">
              <AlertTriangle className="h-4 w-4" />
              Overallocated by {fmt(previewOverallocated)}
            </span>
          ) : previewUnallocated !== null && previewUnallocated > 0 ? (
            <span className="text-muted-foreground">
              Unallocated: <span className="text-foreground font-medium tabular-nums">{fmt(previewUnallocated)}</span>
            </span>
          ) : (
            <span className="text-emerald-700 font-medium">Fully allocated</span>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>Cancel</Button>
          <Button onClick={handleSave} disabled={hasInvalid || isSaving || sortedAllocations.length === 0} data-testid="button-save-allocation-all">
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- top-level section -----------------------------------------------------

export function ChannelPlanSection({ year }: { year: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: mappings } = useListMetricMappings();

  const [editingMetric, setEditingMetric] = useState<PlanMetricDef | null>(null);
  const [allocatingMetric, setAllocatingMetric] = useState<PlanMetricDef | null>(null);

  // Fixed, explicit calls (never a hook inside a loop/map) -- one per
  // targetable metric, always called in the same order every render.
  const closedRevenue = useMetricCascade('closed_revenue', year);
  const sourcedPipeline = useMetricCascade('partner_sourced_pipeline', year);
  const influencedPipeline = useMetricCascade('partner_influenced_pipeline', year);
  const signedPartners = useMetricCascade('signed_partners', year);
  const newProspects = useMetricCascade('new_partner_prospects', year);

  const cascadeByMetric: Record<string, AnnualCascade | undefined> = {
    closed_revenue: closedRevenue.data,
    partner_sourced_pipeline: sourcedPipeline.data,
    partner_influenced_pipeline: influencedPipeline.data,
    signed_partners: signedPartners.data,
    new_partner_prospects: newProspects.data,
  };
  const isLoadingByMetric: Record<string, boolean> = {
    closed_revenue: closedRevenue.isLoading,
    partner_sourced_pipeline: sourcedPipeline.isLoading,
    partner_influenced_pipeline: influencedPipeline.isLoading,
    signed_partners: signedPartners.isLoading,
    new_partner_prospects: newProspects.isLoading,
  };
  const dataStatusByMetric = (metricKey: string) => mappings?.find((m) => m.metric_key === metricKey)?.current_data_status;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAnnualCascadeQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTeamTargetsQueryKey() });
  };

  return (
    <section className="space-y-4 max-w-5xl" data-testid="section-channel-plan">
      <h2 className="text-section-title">Channel Plan -- {year}</h2>

      <PlanMetricCard
        metric={PRIMARY_PLAN_METRICS[0]}
        cascade={cascadeByMetric[PRIMARY_PLAN_METRICS[0].key]}
        isLoading={isLoadingByMetric[PRIMARY_PLAN_METRICS[0].key]}
        dataStatus={dataStatusByMetric(PRIMARY_PLAN_METRICS[0].key)}
        featured
        onEditTarget={() => setEditingMetric(PRIMARY_PLAN_METRICS[0])}
        onManageAllocation={() => setAllocatingMetric(PRIMARY_PLAN_METRICS[0])}
      />

      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Pipeline</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {PRIMARY_PLAN_METRICS.slice(1).map((metric) => (
            <PlanMetricCard
              key={metric.key}
              metric={metric}
              cascade={cascadeByMetric[metric.key]}
              isLoading={isLoadingByMetric[metric.key]}
              dataStatus={dataStatusByMetric(metric.key)}
              onEditTarget={() => setEditingMetric(metric)}
              onManageAllocation={() => setAllocatingMetric(metric)}
            />
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Partner development</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {SECONDARY_PLAN_METRICS.map((metric) => (
            <PlanMetricCard
              key={metric.key}
              metric={metric}
              cascade={cascadeByMetric[metric.key]}
              isLoading={isLoadingByMetric[metric.key]}
              dataStatus={dataStatusByMetric(metric.key)}
              onEditTarget={() => setEditingMetric(metric)}
              onManageAllocation={() => setAllocatingMetric(metric)}
            />
          ))}
        </div>
      </div>

      {editingMetric && (
        <EditAnnualTargetDialog
          year={year}
          currentValue={cascadeByMetric[editingMetric.key]?.annual_target ?? null}
          metricKey={editingMetric.key}
          metricLabel={editingMetric.label}
          isMoney={editingMetric.isMoney}
          onClose={() => setEditingMetric(null)}
          onSaved={() => { invalidate(); setEditingMetric(null); toast({ title: 'Annual target saved' }); }}
        />
      )}

      {allocatingMetric && (
        <AllocateAnnualTargetDialog
          year={year}
          metricKey={allocatingMetric.key}
          metricLabel={allocatingMetric.label}
          isMoney={allocatingMetric.isMoney}
          annualTarget={cascadeByMetric[allocatingMetric.key]?.annual_target ?? null}
          allocations={cascadeByMetric[allocatingMetric.key]?.allocations ?? []}
          onClose={() => setAllocatingMetric(null)}
          onSaved={() => { invalidate(); setAllocatingMetric(null); toast({ title: 'Allocation saved' }); }}
        />
      )}
    </section>
  );
}
