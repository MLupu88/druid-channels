import React, { useState } from 'react';
import { useGetWeeklyTeamReport } from '@workspace/api-client-react';
import type { WeeklyTargetProgress } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { X, ChevronLeft, ChevronRight, AlertTriangle, Info } from 'lucide-react';
import { getDefaultWeekStart, addWeeks, weekLabel } from '@/lib/period';
import { WeeklyReport } from '@/pages/weekly-report';

function money(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// Three states, not a boolean: a PAM with only no_target territories is
// neither "ahead" nor "behind" -- that would be a fabricated status for a
// territory nobody set a target for. Only an ACTIONABLE target (status
// ahead/behind) can decide this; if none exist, the honest answer is "No
// target".
function aggregateTargetLabel(targets: WeeklyTargetProgress[]): 'no_target' | 'behind' | 'ahead' {
  const actionable = targets.filter((t) => t.status !== 'no_target');
  if (actionable.length === 0) return 'no_target';
  if (actionable.some((t) => t.status === 'behind')) return 'behind';
  return 'ahead';
}

function WeekSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isCurrent = value >= getDefaultWeekStart();
  return (
    <div className="flex items-center gap-1.5">
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onChange(addWeeks(value, -1))} data-testid="button-team-prev-week">
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div className="text-sm font-medium w-[210px] text-center tabular-nums" data-testid="text-team-week-label">
        {weekLabel(value)}
      </div>
      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onChange(addWeeks(value, 1))} disabled={isCurrent} data-testid="button-team-next-week">
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function HeadlineTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * Phase 7 -- Head/Admin consolidated weekly team view. team_commercial/
 * team_marketing come pre-aggregated from GET /reporting/weekly/team
 * (weeklyReportingService.getTeamWeeklyReport), which derives them entirely
 * from the same pam_reports shown in the table below -- never a separately
 * computed figure -- so this page never needs (and never performs) its own
 * aggregation.
 */
export default function WeeklyTeamReport() {
  const [weekStart, setWeekStart] = useState(getDefaultWeekStart());
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  const { data: report, isLoading, isError, error } = useGetWeeklyTeamReport({ week_start: weekStart });

  const totalConflicts = (report?.team_commercial.conflicts.length ?? 0) + (report?.team_marketing.conflicts.length ?? 0);

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Team weekly report</h1>
            <p className="text-sm text-muted-foreground mt-1">Who's on track, where pipeline is moving, and what needs your attention.</p>
          </div>
          <WeekSelector value={weekStart} onChange={setWeekStart} />
        </div>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}

        {isError && (
          <Card className="shadow-none border-destructive/40">
            <CardContent className="p-6 text-sm text-destructive">
              Could not load the team report{error instanceof Error ? `: ${error.message}` : '.'}
            </CardContent>
          </Card>
        )}

        {report && (
          <>
            <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
              <Badge variant="outline" className="font-normal">
                {report.report_state_summary.submitted_count} submitted · {report.report_state_summary.draft_count} in progress
              </Badge>
              {report.pams_with_multiple_territories.length > 0 && (
                <Badge variant="outline" className="font-normal gap-1">
                  <Info className="h-3 w-3" /> {report.pams_with_multiple_territories.length} PAM(s) own multiple territories
                </Badge>
              )}
              {totalConflicts > 0 && (
                <Badge variant="outline" className="font-normal gap-1 text-amber-700 bg-amber-50 border-amber-200">
                  <AlertTriangle className="h-3 w-3" /> {totalConflicts} data conflict{totalConflicts === 1 ? '' : 's'} detected (see below)
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <HeadlineTile
                label="Team open pipeline"
                value={money(report.team_commercial.open_pipeline_usd.total)}
                sub={`Sourced ${money(report.team_commercial.open_pipeline_usd.sourced)} · Influenced ${money(report.team_commercial.open_pipeline_usd.influenced)}`}
              />
              <HeadlineTile
                label="Team won revenue (this week)"
                value={money(report.team_commercial.won_revenue_usd.total)}
                sub={`${report.team_commercial.deals_won_count} deal${report.team_commercial.deals_won_count === 1 ? '' : 's'} won`}
              />
              <HeadlineTile label="New opportunities (this week)" value={report.team_commercial.opportunities_created_count} />
              <HeadlineTile
                label="Marketing activities (this week)"
                value={report.team_marketing.activity_count}
                sub={`${money(report.team_marketing.commercial_impact.open_pipeline_usd)} pipeline, ${money(report.team_marketing.commercial_impact.won_revenue_usd)} revenue touched`}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <HeadlineTile label="Stalled recruitment" value={report.attention_summary.stalled_recruitment_count} />
              <HeadlineTile label="Relationships needing attention" value={report.attention_summary.relationships_needing_attention_count} />
              <HeadlineTile label="PAMs behind target" value={report.attention_summary.pams_behind_target} />
            </div>

            <Card className="shadow-none border-border/60">
              <CardHeader className="py-3 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-sm font-medium">By PAM</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>PAM</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Open pipeline</TableHead>
                      <TableHead className="text-right">Won revenue</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead className="text-right">Attention</TableHead>
                      <TableHead className="w-[110px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.pam_reports.length === 0 ? (
                      <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No PAMs found for this week.</TableCell></TableRow>
                    ) : (
                      report.pam_reports.map((r) => {
                        const targetLabel = aggregateTargetLabel(r.metrics.commercial.targets);
                        return (
                          <TableRow key={r.pam_user_id}>
                            <TableCell className="font-medium">
                              {r.pam_name}
                              {r.current_role !== 'pam' && <span className="text-xs text-muted-foreground ml-1.5">(no longer PAM)</span>}
                            </TableCell>
                            <TableCell>
                              {r.status === 'submitted' ? (
                                <Badge variant="outline" className="font-normal bg-emerald-50 text-emerald-700 border-emerald-200">Submitted</Badge>
                              ) : (
                                <Badge variant="outline" className="font-normal text-muted-foreground">Draft</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{money(r.metrics.commercial.open_pipeline_usd.total)}</TableCell>
                            <TableCell className="text-right tabular-nums">{money(r.metrics.commercial.won_revenue_usd.total)}</TableCell>
                            <TableCell>
                              {targetLabel === 'no_target' ? (
                                <Badge variant="outline" className="font-normal text-muted-foreground">No target</Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className={`font-normal ${targetLabel === 'ahead' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}
                                >
                                  {targetLabel === 'ahead' ? 'Ahead' : 'Behind'}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{r.metrics.attention.length || '—'}</TableCell>
                            <TableCell>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setSelected({ id: r.pam_user_id, name: r.pam_name })}
                                data-testid={`button-view-report-${r.pam_user_id}`}
                              >
                                View report
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {report.help_requests.length > 0 && (
              <Card className="shadow-none border-border/60">
                <CardHeader className="py-3 px-5 border-b border-border/50 bg-muted/20">
                  <CardTitle className="text-sm font-medium">Help requested</CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {report.help_requests.map((h) => (
                    <div key={h.pam_user_id} className="text-sm">
                      <span className="font-medium">{h.pam_name}:</span> <span className="text-muted-foreground">{h.help_needed}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {totalConflicts > 0 && (
              <Card className="shadow-none border-amber-200 bg-amber-50/40">
                <CardHeader className="py-3 px-5 border-b border-amber-200/60">
                  <CardTitle className="text-sm font-medium flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4 text-amber-600" /> Data conflicts ({totalConflicts})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-2 text-xs text-muted-foreground">
                  <p>
                    The same opportunity was reported with different values across two PAMs' reports this week (likely a mid-week
                    reassignment). The team totals above use the most recent value for each; nothing was silently dropped.
                  </p>
                  {report.team_commercial.conflicts.length > 0 && <p>{report.team_commercial.conflicts.length} commercial pipeline/revenue conflict(s).</p>}
                  {report.team_marketing.conflicts.length > 0 && <p>{report.team_marketing.conflicts.length} marketing-linked opportunity conflict(s).</p>}
                </CardContent>
              </Card>
            )}

            <p className="text-xs text-muted-foreground">
              Week of {report.week_start} through {report.week_end} · Generated {new Date(report.generated_at).toLocaleString()}
            </p>
          </>
        )}
      </div>

      {selected && (
        <div className="w-[720px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-muted/10 shrink-0">
            <h3 className="font-medium">{selected.name}'s weekly report</h3>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setSelected(null)} data-testid="button-close-drilldown">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-auto">
            <WeeklyReport pamUserId={selected.id} pamName={selected.name} weekStartOverride={weekStart} />
          </div>
        </div>
      )}
    </div>
  );
}
