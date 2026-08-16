import React, { useState } from 'react';
import {
  useGetAnnualCascade,
  getGetAnnualCascadeQueryKey,
  useUpsertAnnualTarget,
  useUpsertMetricTarget,
  getListTeamTargetsQueryKey,
  useListTeamTargets,
} from '@workspace/api-client-react';
import type { AnnualCascade, PamAllocation, WeeklyKpiRow } from '@workspace/api-client-react';
import { CardHeader, CardTitle } from '@/components/ui/card';
import { SectionCard, SectionCardHeader, SectionCardContent } from '@/components/section-card';
import { MetricTile } from '@/components/metric-tile';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, TrendingUp, AlertTriangle } from 'lucide-react';
import { formatCount, formatUsd, formatMetricValue, type Currency } from '@/lib/kpi-format';
import { joinPeriodKey, getCurrentQuarterKey } from '@/lib/period';
import { deriveAllocationStatus } from '@/lib/commercial-cascade';

// Allocation quarters are always exactly q1-q4 -- "ytd" is a reporting-
// period concept (see lib/period.ts's QuarterKey) that never applies to a
// PAM allocation row, so it's deliberately excluded from this narrower type
// rather than reusing QuarterKey directly.
type AllocationQuarterKey = 'q1' | 'q2' | 'q3' | 'q4';

// Phase 5B-1: the annual company-wide commercial target this whole section
// is built around. "Annual channel commercial target" in the product
// narrative always means closed revenue -- the other targetable metrics
// (new_partner_prospects, signed_partners, partner_sourced_pipeline,
// partner_influenced_pipeline) already have their own Team Targets flow and
// are not part of the Irina-annual-target -> quarterly-PAM-allocation
// cascade this section renders. This is a deliberate scope choice for
// Phase 5B-1, not a technical limitation of the API (GET/PUT
// /metric-targets/annual and /metric-targets/annual-cascade both take an
// arbitrary metric_key).
const ANNUAL_TARGET_METRIC_KEY = 'closed_revenue';

// Currency-semantics review (post-implementation): metric_targets.target_value
// has no currency column at all -- but for a money metric it is not an
// undefined unit either. The backend already has one consistent, load-
// bearing convention for it: buildHeadOfChannelsData/getKpiDetails treat a
// money metric's target_value as canonical USD, running it through the
// exact same convertMoney(value, usd_to_currency_rate) as `current` before
// display (see kpiService.ts). computeAnnualActual (targetService.ts) is
// even more direct: it normalizes every opportunity's deal_value/
// credit_value to USD via resolveFx before summing, so AnnualCascade's
// `actual`/`attainment_percent` are USD by explicit construction, not just
// convention. Every other cascade figure (annual_target, allocated_to_pams,
// quarterly_totals, unallocated_amount, overallocated_amount) is derived
// from that same target_value storage for the SAME money metric
// (closed_revenue), so the identical "target_value for a money metric is
// USD" convention applies to all of them.
//
// GET /metric-targets/annual-cascade and GET /team-targets both return
// these USD figures with NO currency conversion applied (no currency query
// param exists on either route) -- unlike weekly_commercial's `current`/
// `target`, which ARE converted to the page's selected display currency.
// So these two families of numbers can legitimately differ in currency on
// the same page. To make that impossible to misread, every cascade/target
// figure here is explicitly formatted (via kpi-format.ts's formatUsd) and
// labeled as USD (never the page's selected currency, and never a bare
// unlabeled number that could be mistaken for it).

const QUARTERS: AllocationQuarterKey[] = ['q1', 'q2', 'q3', 'q4'];
const QUARTER_LABEL: Record<AllocationQuarterKey, string> = { q1: 'Q1', q2: 'Q2', q3: 'Q3', q4: 'Q4' };

function StatTile({ label, value, accentClassName }: { label: string; value: React.ReactNode; accentClassName?: string }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${accentClassName ?? ''}`}>{value}</p>
    </div>
  );
}

function weeklyRow(kpis: WeeklyKpiRow[] | undefined, metricKey: string): WeeklyKpiRow | undefined {
  return kpis?.find((r) => r.metric_key === metricKey);
}

// ---- Head / Admin ------------------------------------------------------------

export function CommercialPerformanceHead({
  weeklyCommercial,
  year,
  currency,
}: {
  weeklyCommercial: WeeklyKpiRow[] | undefined;
  year: number;
  currency: Currency;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const cascadeParams = { metric_key: ANNUAL_TARGET_METRIC_KEY, year };
  const { data: cascade, isLoading } = useGetAnnualCascade(cascadeParams, {
    query: { queryKey: getGetAnnualCascadeQueryKey(cascadeParams) },
  });

  const [editTargetOpen, setEditTargetOpen] = useState(false);
  const [editingAllocation, setEditingAllocation] = useState<PamAllocation | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAnnualCascadeQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListTeamTargetsQueryKey() });
  };

  const sourced = weeklyRow(weeklyCommercial, 'partner_sourced_pipeline');
  const influenced = weeklyRow(weeklyCommercial, 'partner_influenced_pipeline');
  const closedRevenue = weeklyRow(weeklyCommercial, 'closed_revenue');
  const opportunitiesCreated = weeklyRow(weeklyCommercial, 'opportunities_created');

  if (isLoading) {
    return (
      <div className="max-w-5xl">
        <Skeleton className="h-[220px] w-full rounded-md" />
      </div>
    );
  }
  if (!cascade) return null;

  const allocationStatus = deriveAllocationStatus(cascade);

  return (
    <section className="space-y-3 max-w-5xl" data-testid="section-commercial-performance-head">
      <div className="flex items-center justify-between">
        <h2 className="text-section-title flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-brand" />
          Commercial Performance -- {year}
        </h2>
      </div>

      <SectionCard>
        <SectionCardHeader
          title="Annual target & attainment"
          actions={
            <Button variant="outline" size="sm" onClick={() => setEditTargetOpen(true)} data-testid="button-edit-annual-target">
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              {cascade.annual_target === null ? 'Set annual target' : 'Edit annual target'}
            </Button>
          }
        />
        <SectionCardContent className="space-y-4">
          <p className="text-xs text-muted-foreground -mt-1" data-testid="text-annual-target-currency-note">
            Annual target, attainment, and allocation figures below are always shown in USD -- the pipeline/revenue tiles use your selected display currency ({currency}).
          </p>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <StatTile label="Annual target (USD)" value={cascade.annual_target === null ? 'Not set' : formatUsd(cascade.annual_target)} />
            <StatTile
              label="Target credit / attainment"
              value={cascade.attainment_percent === null ? '--' : `${cascade.attainment_percent}%`}
              accentClassName={cascade.attainment_percent !== null && cascade.attainment_percent >= 100 ? 'text-emerald-600' : undefined}
            />
            <StatTile label={`Sourced pipeline (${currency})`} value={formatMetricValue(sourced?.current, 'partner_sourced_pipeline', currency)} accentClassName="text-sky-700" />
            <StatTile label={`Influenced pipeline (${currency})`} value={formatMetricValue(influenced?.current, 'partner_influenced_pipeline', currency)} accentClassName="text-violet-700" />
            {/* Phase 11.6B: Closed revenue is the one primary/dominant commercial
                figure on this page (money first, per the 11.6 visual-system
                direction) -- MetricTile's variant="primary" is the only tile
                swapped from the local StatTile helper, since it's the only one
                the product requirement calls out for visual dominance; the
                rest keep their existing accent-colored StatTile treatment
                unchanged. Same label/value expression as before. */}
            <MetricTile label={`Closed revenue (${currency})`} value={formatMetricValue(closedRevenue?.current, 'closed_revenue', currency)} variant="primary" />
            <StatTile label="Opportunities" value={formatCount(opportunitiesCreated?.current)} />
          </div>

          <div className="rounded-md border border-border/60 p-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="text-muted-foreground">
              Allocated to PAMs (USD): <span className="text-foreground font-medium tabular-nums">{formatUsd(cascade.allocated_to_pams)}</span>
            </span>
            {allocationStatus === 'overallocated' && (
              <span className="flex items-center gap-1.5 text-rose-700 font-medium">
                <AlertTriangle className="h-4 w-4" />
                Overallocated by {formatUsd(cascade.overallocated_amount)}
              </span>
            )}
            {allocationStatus === 'underallocated' && (
              <span className="text-muted-foreground">
                Unallocated (USD): <span className="text-foreground font-medium tabular-nums">{formatUsd(cascade.unallocated_amount)}</span>
              </span>
            )}
            {allocationStatus === 'exact' && (
              <span className="flex items-center gap-1.5 text-emerald-700 font-medium">Fully allocated</span>
            )}
            {allocationStatus === 'no_target' && (
              <span className="text-muted-foreground">Set an annual target to see unallocated/overallocated amounts.</span>
            )}
          </div>
        </SectionCardContent>
      </SectionCard>

      {/* Phase 11.6B: this card's header keeps its original hand-written
          CardHeader/CardTitle (not SectionCardHeader) specifically to
          preserve the text-allocation-table-currency-note data-testid,
          which tests/commercialCurrencyDisplay.test.ts asserts on as a
          literal source string -- SectionCardHeader's description slot
          doesn't accept a custom data-testid. Only the outer Card ->
          SectionCard swap (identical rendered classes) applies here. */}
      <SectionCard>
        <CardHeader className="py-4 px-5 border-b border-border/60 bg-muted/20">
          <CardTitle className="text-base font-medium">PAM quarterly allocations</CardTitle>
          <p className="text-xs text-muted-foreground" data-testid="text-allocation-table-currency-note">All amounts in USD.</p>
        </CardHeader>
        <SectionCardContent noPadding>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>PAM</TableHead>
                <TableHead>Territory</TableHead>
                <TableHead className="text-right">Q1 (USD)</TableHead>
                <TableHead className="text-right">Q2 (USD)</TableHead>
                <TableHead className="text-right">Q3 (USD)</TableHead>
                <TableHead className="text-right">Q4 (USD)</TableHead>
                <TableHead className="text-right">Annual allocation (USD)</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cascade.allocations.length > 0 ? (
                cascade.allocations.map((allocation) => {
                  const total = (allocation.q1 ?? 0) + (allocation.q2 ?? 0) + (allocation.q3 ?? 0) + (allocation.q4 ?? 0);
                  return (
                    <TableRow key={`${allocation.pam_user_id}-${allocation.territory_id}`}>
                      <TableCell className="font-medium">{allocation.pam_name}</TableCell>
                      <TableCell className="text-muted-foreground">{allocation.territory_name}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{allocation.q1 === null ? '--' : formatUsd(allocation.q1)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{allocation.q2 === null ? '--' : formatUsd(allocation.q2)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{allocation.q3 === null ? '--' : formatUsd(allocation.q3)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{allocation.q4 === null ? '--' : formatUsd(allocation.q4)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatUsd(total)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditingAllocation(allocation)} data-testid={`button-edit-allocation-${allocation.pam_user_id}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No PAMs own a territory yet -- assign one from Settings &gt; Team.</TableCell>
                </TableRow>
              )}
            </TableBody>
            {cascade.allocations.length > 0 && (
              <tfoot>
                <TableRow className="hover:bg-transparent bg-muted/20">
                  <TableCell colSpan={2} className="font-medium">Quarterly totals</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatUsd(cascade.quarterly_totals.q1)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatUsd(cascade.quarterly_totals.q2)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatUsd(cascade.quarterly_totals.q3)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatUsd(cascade.quarterly_totals.q4)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatUsd(cascade.allocated_to_pams)}</TableCell>
                  <TableCell />
                </TableRow>
              </tfoot>
            )}
          </Table>
        </SectionCardContent>
      </SectionCard>

      {editTargetOpen && (
        <EditAnnualTargetDialog
          year={year}
          currentValue={cascade.annual_target}
          metricKey={ANNUAL_TARGET_METRIC_KEY}
          metricLabel="Closed revenue"
          isMoney
          onClose={() => setEditTargetOpen(false)}
          onSaved={() => { invalidate(); setEditTargetOpen(false); toast({ title: 'Annual target saved' }); }}
        />
      )}

      {editingAllocation && (
        <EditAllocationDialog
          allocation={editingAllocation}
          year={year}
          onClose={() => setEditingAllocation(null)}
          onSaved={() => { invalidate(); setEditingAllocation(null); toast({ title: 'Allocation saved' }); }}
        />
      )}
    </section>
  );
}

// Phase 11.6C: generalized (metricKey/metricLabel/isMoney added, exported)
// so team-targets.tsx's Channel Plan section can reuse this exact dialog
// for all 5 targetable metrics, instead of duplicating its validation/
// mutation logic. CommercialPerformanceHead's own call site below passes
// metricKey={ANNUAL_TARGET_METRIC_KEY} metricLabel="Closed revenue"
// isMoney -- identical values to what were previously hardcoded, so
// Overview's behavior is byte-for-byte unchanged.
export function EditAnnualTargetDialog({
  year,
  currentValue,
  metricKey,
  metricLabel,
  isMoney,
  onClose,
  onSaved,
}: {
  year: number;
  currentValue: number | null;
  metricKey: string;
  metricLabel: string;
  isMoney: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [value, setValue] = useState(currentValue !== null ? String(currentValue) : '');
  const upsertMutation = useUpsertAnnualTarget({
    mutation: {
      onSuccess: onSaved,
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not save annual target', description: err?.message ?? 'Please try again.' }),
    },
  });

  const parsed = value.trim() === '' ? null : Number(value);
  // Phase 11.6C: a count metric (Signed Partners, New Partner Prospects)
  // must never accept a fractional target -- "part of a partner" is
  // nonsensical. Money metrics keep the original unconstrained-decimal
  // behavior (this app's whole-dollar display convention is a formatting
  // choice, formatUsd, not a storage constraint -- see kpi-format.ts).
  const canSubmit = parsed !== null && Number.isFinite(parsed) && parsed >= 0 && (isMoney || Number.isInteger(parsed));

  const handleSubmit = () => {
    if (!canSubmit || parsed === null) return;
    upsertMutation.mutate({ data: { metric_key: metricKey, year, target_value: parsed, note: null } });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{currentValue === null ? 'Set annual target' : 'Edit annual target'}</DialogTitle>
          <DialogDescription>
            {metricLabel} -- {year}. This is the company-wide target; it is never automatically divided across quarters or PAMs.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Label className="text-xs mb-1.5 block">{isMoney ? 'Annual target (USD)' : 'Annual target'}</Label>
          <Input type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} placeholder={isMoney ? 'e.g. 1200000' : 'e.g. 12'} data-testid="input-annual-target-value" />
          {!isMoney && value.trim() !== '' && parsed !== null && Number.isFinite(parsed) && !Number.isInteger(parsed) && (
            <p className="text-xs text-rose-600 mt-1.5">Enter a whole number -- this metric counts partners, not a fraction of one.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || upsertMutation.isPending} data-testid="button-save-annual-target">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditAllocationDialog({
  allocation,
  year,
  onClose,
  onSaved,
}: {
  allocation: PamAllocation;
  year: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [values, setValues] = useState<Record<AllocationQuarterKey, string>>({
    q1: allocation.q1 !== null ? String(allocation.q1) : '',
    q2: allocation.q2 !== null ? String(allocation.q2) : '',
    q3: allocation.q3 !== null ? String(allocation.q3) : '',
    q4: allocation.q4 !== null ? String(allocation.q4) : '',
  });
  const [isSaving, setIsSaving] = useState(false);
  const upsertMutation = useUpsertMetricTarget();

  const parsedValues: Record<AllocationQuarterKey, number | null> = {
    q1: values.q1.trim() === '' ? null : Number(values.q1),
    q2: values.q2.trim() === '' ? null : Number(values.q2),
    q3: values.q3.trim() === '' ? null : Number(values.q3),
    q4: values.q4.trim() === '' ? null : Number(values.q4),
  };
  const hasInvalid = QUARTERS.some((q) => {
    const v = parsedValues[q];
    return v !== null && (!Number.isFinite(v) || v < 0);
  });

  const handleSubmit = async () => {
    if (hasInvalid) return;
    setIsSaving(true);
    try {
      // Only quarters that were actually entered are saved -- an empty
      // field is left unset rather than written as a fabricated 0. Each
      // quarter is its own metric_targets row (period=q1..q4), so quarters
      // are saved independently, never derived from one another.
      const toSave = QUARTERS.filter((q) => parsedValues[q] !== null);
      await Promise.all(
        toSave.map((q) =>
          upsertMutation.mutateAsync({
            data: {
              metric_key: ANNUAL_TARGET_METRIC_KEY,
              period: joinPeriodKey(year, q) as any,
              territory_id: allocation.territory_id,
              pam_user_id: allocation.pam_user_id,
              target_value: parsedValues[q]!,
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

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Edit quarterly allocation</DialogTitle>
          <DialogDescription>
            {allocation.pam_name} -- {allocation.territory_name} -- {year}. Genuine per-quarter allocations in USD, not a share of the annual target.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2 grid grid-cols-2 gap-3">
          {QUARTERS.map((q) => (
            <div key={q}>
              <Label className="text-xs mb-1.5 block">{QUARTER_LABEL[q]}</Label>
              <Input
                type="number"
                min="0"
                value={values[q]}
                onChange={(e) => setValues((prev) => ({ ...prev, [q]: e.target.value }))}
                placeholder="e.g. 300000"
                data-testid={`input-allocation-${q}`}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={hasInvalid || isSaving} data-testid="button-save-allocation">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- PAM ---------------------------------------------------------------------

// Compact, read-only commercial block for a PAM's own Overview. Uses
// GET /team-targets (already self-scoped to the caller by the backend, same
// endpoint team-targets.tsx/pam-workspace.tsx already rely on for a PAM's
// own quarterly target/actual/attainment) for the target/attainment figure,
// and the same weeklyCommercial rows Overview already fetched for
// pipeline/closed-revenue/opportunities -- no new KPI computation logic in
// React, no annual-cascade call (that endpoint is Head/Admin-only).
export function CommercialPerformancePam({ weeklyCommercial, currency }: { weeklyCommercial: WeeklyKpiRow[] | undefined; currency: Currency }) {
  const period = joinPeriodKey(new Date().getFullYear(), getCurrentQuarterKey());
  const { data: teamTargetRows, isLoading } = useListTeamTargets({ period });

  const closedRevenueTarget = teamTargetRows?.find((r) => r.metric_key === 'closed_revenue');

  const sourced = weeklyRow(weeklyCommercial, 'partner_sourced_pipeline');
  const influenced = weeklyRow(weeklyCommercial, 'partner_influenced_pipeline');
  const closedRevenue = weeklyRow(weeklyCommercial, 'closed_revenue');
  const opportunitiesCreated = weeklyRow(weeklyCommercial, 'opportunities_created');

  if (isLoading) {
    return (
      <div className="max-w-5xl">
        <Skeleton className="h-[140px] w-full rounded-md" />
      </div>
    );
  }

  return (
    <section className="space-y-3 max-w-5xl" data-testid="section-commercial-performance-pam">
      <h2 className="text-section-title flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-brand" />
        My Commercial Performance
      </h2>
      <SectionCard>
        <SectionCardContent className="space-y-4">
          <p className="text-xs text-muted-foreground" data-testid="text-pam-target-currency-note">
            Quarter target and attainment are always shown in USD -- pipeline/revenue tiles use your selected display currency ({currency}).
          </p>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <StatTile label="Quarter target (USD)" value={closedRevenueTarget?.target_value === null || closedRevenueTarget?.target_value === undefined ? 'Not set' : formatUsd(closedRevenueTarget.target_value)} />
            <StatTile
              label="Target credit / attainment"
              value={closedRevenueTarget?.progress_percent === null || closedRevenueTarget?.progress_percent === undefined ? '--' : `${closedRevenueTarget.progress_percent}%`}
              accentClassName={closedRevenueTarget?.status === 'ahead' ? 'text-emerald-600' : undefined}
            />
            <StatTile label={`Sourced pipeline (${currency})`} value={formatMetricValue(sourced?.current, 'partner_sourced_pipeline', currency)} accentClassName="text-sky-700" />
            <StatTile label={`Influenced pipeline (${currency})`} value={formatMetricValue(influenced?.current, 'partner_influenced_pipeline', currency)} accentClassName="text-violet-700" />
            <MetricTile label={`Closed revenue (${currency})`} value={formatMetricValue(closedRevenue?.current, 'closed_revenue', currency)} variant="primary" />
            <StatTile label="Opportunities" value={formatCount(opportunitiesCreated?.current)} />
          </div>
        </SectionCardContent>
      </SectionCard>
    </section>
  );
}
