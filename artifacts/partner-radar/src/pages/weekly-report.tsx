import React, { useState, useEffect } from 'react';
import {
  useGetMyWeeklyReport,
  useGetPamWeeklyReport,
  useListMyWeeklyReportHistory,
  useUpsertMyWeeklyCommentary,
  useSubmitMyWeeklyReport,
  getGetMyWeeklyReportQueryKey,
  getGetPamWeeklyReportQueryKey,
  getListMyWeeklyReportHistoryQueryKey,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { getDefaultWeekStart, addWeeks, weekLabel } from '@/lib/period';
import { ChevronLeft, ChevronRight, Lock, AlertTriangle, History } from 'lucide-react';

function money(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function WeekSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isCurrent = value >= getDefaultWeekStart();
  return (
    <div className="flex items-center gap-1.5">
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onChange(addWeeks(value, -1))} data-testid="button-prev-week">
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div className="text-sm font-medium w-[210px] text-center tabular-nums" data-testid="text-week-label">
        {weekLabel(value)}
      </div>
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onChange(addWeeks(value, 1))} disabled={isCurrent} data-testid="button-next-week">
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function MetricTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: 'draft' | 'submitted' }) {
  return status === 'submitted' ? (
    <Badge variant="outline" className="font-normal bg-emerald-50 text-emerald-700 border-emerald-200">Submitted</Badge>
  ) : (
    <Badge variant="outline" className="font-normal text-muted-foreground">Draft</Badge>
  );
}

/**
 * Phase 7 weekly PAM report. Used both as a PAM's own "/my-weekly-report"
 * (no pamUserId -- self-service via GET/PUT/POST /reporting/weekly/me*) and
 * as the Head/Admin drill-down from the team view (explicit pamUserId,
 * read-only, GET /reporting/weekly/pam/:userId) -- same component, same
 * rendering, so the drill-down can never show a different shape than what
 * the PAM sees themselves.
 *
 * weekStartOverride, when provided (the team-view drill-down case), makes
 * the week fully controlled by the parent: this component never falls back
 * to its own current-week default and never shows its own week selector --
 * the team page stays the single source of truth for which week is being
 * viewed, including reactively if the parent's own selection changes while
 * the drill-down panel is open.
 */
export function WeeklyReport({ pamUserId, pamName, weekStartOverride }: { pamUserId?: string; pamName?: string; weekStartOverride?: string }) {
  const [internalWeekStart, setInternalWeekStart] = useState(getDefaultWeekStart());
  const weekStart = weekStartOverride ?? internalWeekStart;
  const isWeekControlledByParent = weekStartOverride !== undefined;
  const { toast } = useToast();
  const isDrillDown = !!pamUserId;

  const ownQuery = useGetMyWeeklyReport(
    { week_start: weekStart },
    { query: { enabled: !isDrillDown, queryKey: getGetMyWeeklyReportQueryKey({ week_start: weekStart }) } },
  );
  const drillQuery = useGetPamWeeklyReport(
    pamUserId ?? '',
    { week_start: weekStart },
    { query: { enabled: isDrillDown, queryKey: getGetPamWeeklyReportQueryKey(pamUserId ?? '', { week_start: weekStart }) } },
  );
  const { data: report, isLoading, isError, error, refetch } = isDrillDown ? drillQuery : ownQuery;
  const { data: history } = useListMyWeeklyReportHistory(
    { limit: 12 },
    { query: { enabled: !isDrillDown, queryKey: getListMyWeeklyReportHistoryQueryKey({ limit: 12 }) } },
  );

  const [wins, setWins] = useState('');
  const [risks, setRisks] = useState('');
  const [priorities, setPriorities] = useState('');
  const [help, setHelp] = useState('');
  const [dirty, setDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setDirty(false);
  }, [weekStart]);

  useEffect(() => {
    if (report && !dirty) {
      setWins(report.commentary.wins_progress ?? '');
      setRisks(report.commentary.risks_blockers ?? '');
      setPriorities(report.commentary.priorities_next_week ?? '');
      setHelp(report.commentary.help_needed ?? '');
    }
  }, [report, dirty]);

  const saveMutation = useUpsertMyWeeklyCommentary();
  const submitMutation = useSubmitMyWeeklyReport();
  const isBusy = saveMutation.isPending || submitMutation.isPending;

  const commentaryPayload = () => ({
    week_start: weekStart,
    wins_progress: wins || null,
    risks_blockers: risks || null,
    priorities_next_week: priorities || null,
    help_needed: help || null,
  });

  const handleSaveDraft = async () => {
    try {
      await saveMutation.mutateAsync({ data: commentaryPayload() });
      toast({ title: 'Commentary saved' });
      setDirty(false);
      refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Please try again.';
      toast({ variant: 'destructive', title: 'Could not save commentary', description: message });
    }
  };

  // Submission is irreversible (Phase 7 v1 has no reopen workflow), so any
  // unsaved commentary must be persisted FIRST, and only once that succeeds
  // does the report get frozen -- never submit stale/unsaved commentary,
  // and never freeze the report if the save step fails.
  const handleConfirmSubmit = async () => {
    setConfirmOpen(false);
    let stage: 'save' | 'submit' = dirty ? 'save' : 'submit';
    try {
      if (dirty) {
        await saveMutation.mutateAsync({ data: commentaryPayload() });
        setDirty(false);
        stage = 'submit';
      }
      await submitMutation.mutateAsync({ data: { week_start: weekStart } });
      toast({ title: 'Weekly report submitted', description: 'This report is now frozen and read-only.' });
      refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Please try again.';
      toast({
        variant: 'destructive',
        title: stage === 'save' ? 'Could not save commentary before submitting' : 'Could not submit report',
        description: message,
      });
    }
  };

  const isSubmitted = report?.status === 'submitted';
  const commentaryReadOnly = isDrillDown || isSubmitted;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{pamName ? `${pamName}'s weekly report` : 'My weekly report'}</h1>
          <p className="text-sm text-muted-foreground mt-1">What happened this week, are we on track, and what needs attention next week.</p>
        </div>
        <div className="flex items-center gap-3">
          {report && <StatusBadge status={report.status} />}
          {isWeekControlledByParent ? (
            <div className="text-sm font-medium tabular-nums" data-testid="text-week-label">
              {weekLabel(weekStart)}
            </div>
          ) : (
            <WeekSelector value={weekStart} onChange={setInternalWeekStart} />
          )}
        </div>
      </div>

      {!isDrillDown && history && history.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          <span>Recent:</span>
          {history.slice(0, 8).map((h) => (
            <button
              key={h.week_start}
              onClick={() => setInternalWeekStart(h.week_start)}
              className={`px-2 py-0.5 rounded border text-xs ${h.week_start === weekStart ? 'border-primary text-primary' : 'border-border/60 hover:bg-muted/50'}`}
              data-testid={`button-history-${h.week_start}`}
            >
              {h.week_start} {h.status === 'submitted' ? '✓' : ''}
            </button>
          ))}
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {isError && (
        <Card className="shadow-none border-destructive/40">
          <CardContent className="p-6 text-sm text-destructive">
            Could not load this weekly report{error instanceof Error ? `: ${error.message}` : '.'}
          </CardContent>
        </Card>
      )}

      {report && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricTile
              label="Open pipeline"
              value={money(report.metrics.commercial.open_pipeline_usd.total)}
              sub={`Sourced ${money(report.metrics.commercial.open_pipeline_usd.sourced)} · Influenced ${money(report.metrics.commercial.open_pipeline_usd.influenced)}`}
            />
            <MetricTile
              label="Won revenue (this week)"
              value={money(report.metrics.commercial.won_revenue_usd.total)}
              sub={`${report.metrics.commercial.deals_won_count} deal${report.metrics.commercial.deals_won_count === 1 ? '' : 's'} won`}
            />
            <MetricTile label="Open opportunities" value={report.metrics.commercial.opportunity_count_open} />
            <MetricTile label="New opportunities (this week)" value={report.metrics.commercial.opportunities_created_count} />
          </div>

          {report.metrics.commercial.targets.length > 0 && (
            <Card className="shadow-none border-border/60">
              <CardHeader className="py-3 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-sm font-medium">Target progress (quarter to date, as of this week)</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Territory</TableHead>
                      <TableHead className="text-right">Actual / Target</TableHead>
                      <TableHead>Progress</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.metrics.commercial.targets.map((t) => (
                      <TableRow key={t.territory_id}>
                        <TableCell className="font-medium">{t.territory_name}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {money(t.period_actual_usd)} / {t.target_value !== null ? money(t.target_value) : '—'}
                        </TableCell>
                        <TableCell>
                          {t.status === 'no_target' ? (
                            <Badge variant="outline" className="font-normal text-muted-foreground">No target set</Badge>
                          ) : t.status === 'unavailable' ? (
                            <Badge variant="outline" className="font-normal text-muted-foreground">Data unavailable</Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className={`font-normal ${t.status === 'ahead' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}
                            >
                              {t.progress_percent !== null ? `${t.progress_percent}%` : '—'} · {t.status === 'ahead' ? 'Ahead' : 'Behind'}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="shadow-none border-border/60">
              <CardHeader className="py-3 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-sm font-medium">Partner recruitment</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <MetricTile label="New candidates" value={report.metrics.recruitment.new_candidates_count} />
                  <MetricTile label="Stage moves" value={report.metrics.recruitment.stage_transitions_count} />
                  <MetricTile label="Signed" value={report.metrics.recruitment.signed_this_week_count} />
                </div>
                {report.metrics.recruitment.stalled_items.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <div className="text-xs font-medium text-muted-foreground">Stalled ({report.metrics.recruitment.stalled_items.length})</div>
                    {report.metrics.recruitment.stalled_items.slice(0, 5).map((s) => (
                      <div key={s.recruitment_id} className="text-sm flex items-center justify-between border-b border-border/40 py-1 last:border-0">
                        <span>{s.company_name}</span>
                        <span className="text-xs text-muted-foreground">{s.stage.replace(/_/g, ' ')} · {s.days_in_stage}d</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-none border-border/60">
              <CardHeader className="py-3 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-sm font-medium">Marketing activities this week ({report.metrics.marketing.activity_count})</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {report.metrics.marketing.activities.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No activities this week.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Activity</TableHead>
                        <TableHead>Partner</TableHead>
                        <TableHead className="text-right">Linked opps</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.metrics.marketing.activities.map((a) => (
                        <TableRow key={a.campaign_id}>
                          <TableCell className="font-medium">
                            {a.name}
                            <div className="text-xs text-muted-foreground font-normal">{a.type.replace(/_/g, ' ')}</div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{a.partner_company_name ?? '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.linked_opportunity_count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {report.metrics.marketing.commercial_impact.unique_linked_opportunity_count > 0 && (
                  <div className="px-5 py-2.5 text-xs text-muted-foreground border-t border-border/50">
                    Commercial impact: {money(report.metrics.marketing.commercial_impact.open_pipeline_usd)} open pipeline,{' '}
                    {money(report.metrics.marketing.commercial_impact.won_revenue_usd)} won revenue, across{' '}
                    {report.metrics.marketing.commercial_impact.unique_linked_opportunity_count} unique linked opportunit
                    {report.metrics.marketing.commercial_impact.unique_linked_opportunity_count === 1 ? 'y' : 'ies'}.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {report.metrics.attention.length > 0 && (
            <Card className="shadow-none border-amber-200 bg-amber-50/40">
              <CardHeader className="py-3 px-5 border-b border-amber-200/60">
                <CardTitle className="text-sm font-medium flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-amber-600" /> Needs attention ({report.metrics.attention.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                {report.metrics.attention.map((item, i) => (
                  <div key={i} className="text-sm flex items-center justify-between">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-xs text-muted-foreground">{item.detail}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card className="shadow-none border-border/60">
            <CardHeader className="py-3 px-5 border-b border-border/50 bg-muted/20 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium">Weekly commentary</CardTitle>
              {commentaryReadOnly && (
                <Badge variant="outline" className="font-normal text-muted-foreground gap-1">
                  <Lock className="h-3 w-3" /> {isSubmitted ? 'Submitted, read-only' : 'Read-only'}
                </Badge>
              )}
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="wins">Wins / progress</Label>
                  <Textarea
                    id="wins"
                    value={wins}
                    disabled={commentaryReadOnly || isBusy}
                    onChange={(e) => {
                      setWins(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="What moved forward this week?"
                    className="min-h-[90px]"
                    data-testid="textarea-wins"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="risks">Risks / blockers</Label>
                  <Textarea
                    id="risks"
                    value={risks}
                    disabled={commentaryReadOnly || isBusy}
                    onChange={(e) => {
                      setRisks(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="What's at risk or blocked?"
                    className="min-h-[90px]"
                    data-testid="textarea-risks"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="priorities">Priorities for next week</Label>
                  <Textarea
                    id="priorities"
                    value={priorities}
                    disabled={commentaryReadOnly || isBusy}
                    onChange={(e) => {
                      setPriorities(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="What are you focused on next?"
                    className="min-h-[90px]"
                    data-testid="textarea-priorities"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="help">Help needed from Head of Channels</Label>
                  <Textarea
                    id="help"
                    value={help}
                    disabled={commentaryReadOnly || isBusy}
                    onChange={(e) => {
                      setHelp(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="Anything you need unblocked?"
                    className="min-h-[90px]"
                    data-testid="textarea-help"
                  />
                </div>
              </div>

              {!commentaryReadOnly && (
                <div className="flex items-center gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={handleSaveDraft} disabled={isBusy} data-testid="button-save-draft">
                    {saveMutation.isPending ? 'Saving…' : 'Save draft'}
                  </Button>
                  <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={isBusy} data-testid="button-submit-report">
                    {submitMutation.isPending ? 'Submitting…' : 'Submit report'}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Submitting freezes this week's figures and commentary permanently.
                  </span>
                </div>
              )}

              {report.commentary.commentary_updated_at && (
                <p className="text-xs text-muted-foreground">
                  Commentary last updated {new Date(report.commentary.commentary_updated_at).toLocaleString()}
                  {report.submitted_at && ` · Submitted ${new Date(report.submitted_at).toLocaleString()}`}
                </p>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Week of {report.week_start} through {report.week_end}
            {report.metrics.generated_at && ` · Data refreshed ${new Date(report.metrics.generated_at).toLocaleString()}`}
            {report.snapshot_generated_at && report.status === 'submitted' && ` · Frozen ${new Date(report.snapshot_generated_at).toLocaleString()}`}
          </p>
        </>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !isBusy && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit this week's report?</AlertDialogTitle>
            <AlertDialogDescription>
              This week's metrics will be frozen exactly as they are right now, and your commentary becomes read-only.
              Submitted reports cannot be reopened or edited afterward in this version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy} data-testid="button-cancel-submit">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSubmit} disabled={isBusy} data-testid="button-confirm-submit">
              {isBusy ? 'Submitting…' : 'Submit report'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function MyWeeklyReport() {
  return <WeeklyReport />;
}
