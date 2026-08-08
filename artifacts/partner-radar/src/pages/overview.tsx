import React, { useState, useEffect } from 'react';
import {
  useGetHeadOfChannelsKpis,
  useListTerritories,
  useGetKpiDetails,
  getGetKpiDetailsQueryKey,
  exportQuarterlyPptx,
  ApiError,
} from '@workspace/api-client-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowDown, ArrowUp, Minus, X, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { type Currency, formatMetricValue, formatTrendLabel, formatStatusLabel } from '@/lib/kpi-format';

function StatusBadge({ status }: { status: string | null }) {
  if (status === 'green' || status === 'on_track') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal">On track</Badge>;
  if (status === 'amber') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal">Needs attention</Badge>;
  if (status === 'red') return <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal">At risk</Badge>;
  return <Badge variant="outline" className="text-muted-foreground font-normal">--</Badge>;
}

function TrendIcon({ trend }: { trend: string | null }) {
  if (trend === 'up') return <ArrowUp className="h-4 w-4 text-emerald-600 inline" />;
  if (trend === 'down') return <ArrowDown className="h-4 w-4 text-rose-600 inline" />;
  if (trend === 'flat') return <Minus className="h-4 w-4 text-muted-foreground inline" />;
  return null;
}

function DataStatusBadge({ status }: { status: string }) {
  if (status === 'CONNECTED') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal text-xs">Connected</Badge>;
  if (status === 'MANUAL') return <Badge variant="outline" className="text-sky-700 bg-sky-50 border-sky-200 font-normal text-xs">Manual</Badge>;
  if (status === 'DEMO') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal text-xs">Demo data</Badge>;
  return <Badge variant="outline" className="text-muted-foreground font-normal text-xs">Not connected</Badge>;
}

export default function Overview() {
  const { user: activeUser, isGlobalUser } = useAuth();
  const { toast } = useToast();
  const { data: territories } = useListTerritories();
  const ownTerritoryId = !isGlobalUser
    ? territories?.find((t) => t.name === activeUser?.territory)?.id
    : undefined;
  const [territory, setTerritory] = useState<string>('global');
  const [period, setPeriod] = useState<string>('q3');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [selectedKpi, setSelectedKpi] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // PAMs only ever see their own territory's KPIs -- the server enforces
  // this too, but default the selector to it so there's nothing to pick.
  useEffect(() => {
    if (ownTerritoryId && territory === 'global') {
      setTerritory(ownTerritoryId);
    }
  }, [ownTerritoryId]);

  const scopedTerritory = territory === 'global' ? null : territory;

  const { data: kpis, isLoading: isLoadingKpis } = useGetHeadOfChannelsKpis({
    territory: scopedTerritory,
    period,
    currency,
  });
  const detailParams = { metric_key: selectedKpi ?? '', territory: scopedTerritory, period, currency };
  const { data: detail, isLoading: isLoadingDetail } = useGetKpiDetails(
    detailParams,
    { query: { enabled: Boolean(selectedKpi), queryKey: getGetKpiDetailsQueryKey(detailParams) } },
  );

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const blob = await exportQuarterlyPptx({ territory: scopedTerritory, period, currency });
      const territoryLabel = territory === 'global' ? 'global' : (territories?.find((t) => t.id === territory)?.name ?? territory);
      const fileName = `partner-radar-${period}-${territoryLabel.toLowerCase().replace(/\s+/g, '-')}.pptx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Export ready', description: 'Your PowerPoint report has downloaded.' });
    } catch (err) {
      let description = 'Something went wrong generating the report. Please try again.';
      if (err instanceof ApiError) {
        if (err.status === 400) description = err.message || 'Invalid export request -- check the selected period, territory, or currency.';
        else if (err.status === 403) description = 'You do not have access to export this territory.';
        else if (err.status === 503) description = 'The exchange rate is temporarily unavailable. Try again shortly, or export in USD.';
        else description = err.message || description;
      }
      toast({ title: 'Export failed', description, variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  const isHeadOfChannels = activeUser?.role === 'head_of_channels';

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Global partner development and channel performance.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-[140px] bg-card">
                <SelectValue placeholder="Period" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="q1">Q1 2026</SelectItem>
                <SelectItem value="q2">Q2 2026</SelectItem>
                <SelectItem value="q3">Q3 2026</SelectItem>
                <SelectItem value="q4">Q4 2026</SelectItem>
                <SelectItem value="ytd">Year to date</SelectItem>
              </SelectContent>
            </Select>

            <Select value={territory} onValueChange={setTerritory}>
              <SelectTrigger className="w-[200px] bg-card">
                <SelectValue placeholder="Territory" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global (All)</SelectItem>
                {territories?.map(t => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
              <SelectTrigger className="w-[110px] bg-card" data-testid="select-currency">
                <SelectValue placeholder="Currency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD ($)</SelectItem>
                <SelectItem value="EUR">EUR (€)</SelectItem>
                <SelectItem value="GBP">GBP (£)</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              className="bg-card"
              onClick={handleExport}
              disabled={isExporting}
              data-testid="button-export-pptx"
            >
              {isExporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              {isExporting ? 'Exporting…' : 'Export PowerPoint'}
            </Button>
          </div>
        </div>

        {isLoadingKpis ? (
          <div className="space-y-6">
            <Skeleton className="h-[200px] w-full rounded-md" />
            <Skeleton className="h-[200px] w-full rounded-md" />
            <Skeleton className="h-[200px] w-full rounded-md" />
          </div>
        ) : kpis ? (
          <div className="space-y-6 max-w-5xl">
            {/* Table 1: Partner development */}
            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">Partner development</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[250px] font-medium text-muted-foreground">KPI</TableHead>
                      <TableHead className="font-medium text-muted-foreground text-right">Current</TableHead>
                      <TableHead className="font-medium text-muted-foreground text-right">Target</TableHead>
                      <TableHead className="font-medium text-muted-foreground">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {kpis.partner_development.map((row, i) => (
                      <TableRow
                        key={i}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => setSelectedKpi(row.metric_key)}
                      >
                        <TableCell className="font-medium">{row.metric}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMetricValue(row.current, row.metric_key, currency)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatMetricValue(row.target, row.metric_key, currency)}</TableCell>
                        <TableCell><StatusBadge status={row.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Table 2: Weekly commercial performance -- Current / Last Week / Target / Trend */}
            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">Weekly commercial performance</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[250px] font-medium text-muted-foreground">Metric</TableHead>
                      <TableHead className="font-medium text-muted-foreground text-right">Current</TableHead>
                      <TableHead className="font-medium text-muted-foreground text-right">Last Week</TableHead>
                      <TableHead className="font-medium text-muted-foreground text-right">Target</TableHead>
                      <TableHead className="font-medium text-muted-foreground">Trend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {kpis.weekly_commercial.map((row, i) => (
                      <TableRow
                        key={i}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => setSelectedKpi(row.metric_key)}
                      >
                        <TableCell className="font-medium">{row.metric}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMetricValue(row.current, row.metric_key, currency)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatMetricValue(row.last_week, row.metric_key, currency)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatMetricValue(row.target, row.metric_key, currency)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <TrendIcon trend={row.trend} />
                            <span className="text-sm capitalize">{formatTrendLabel(row.trend)}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Table 3: Weekly channel marketing -- This Week / Trend only, no visible Last Week (locked semantics) */}
            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">Weekly channel marketing</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[220px] font-medium text-muted-foreground">Metric</TableHead>
                      <TableHead className="font-medium text-muted-foreground text-right">This Week</TableHead>
                      <TableHead className="font-medium text-muted-foreground">Trend</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {kpis.weekly_marketing.map((row, i) => (
                      <TableRow
                        key={i}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => setSelectedKpi(row.metric_key)}
                      >
                        <TableCell className="font-medium">{row.metric}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMetricValue(row.this_week, row.metric_key, currency)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <TrendIcon trend={row.trend} />
                            <span className="text-sm capitalize">{formatTrendLabel(row.trend)}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground">No data available.</div>
        )}
      </div>

      {/* Right Side Slide-over Panel for Details */}
      {selectedKpi && (
        <div className="w-[420px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)] transition-transform duration-300">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-muted/10">
            <h3 className="font-medium">{detail?.metric ?? 'Metric'} details</h3>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setSelectedKpi(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-5 space-y-6">
              {isLoadingDetail ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : detail ? (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <DataStatusBadge status={detail.data_status} />
                      <StatusBadge status={detail.status ?? null} />
                    </div>
                    {detail.reconciles === false && (
                      <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal text-xs">Reconciliation mismatch</Badge>
                    )}
                  </div>

                  {/* Current / actual-to-date, target-to-date, dynamic full-period target, variance */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Current</p>
                      <p className="text-lg font-semibold tabular-nums">{formatMetricValue(detail.current, detail.metric_key, currency)}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Target-to-date</p>
                      <p className="text-lg font-semibold tabular-nums">{formatMetricValue(detail.target_to_date, detail.metric_key, currency)}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{detail.full_period_target_label}</p>
                      <p className="text-lg font-semibold tabular-nums">{formatMetricValue(detail.full_period_target, detail.metric_key, currency)}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Variance</p>
                      <p className={cn(
                        'text-lg font-semibold tabular-nums',
                        detail.variance !== null && detail.variance !== undefined && (detail.variance >= 0 ? 'text-emerald-600' : 'text-rose-600'),
                      )}>
                        {formatMetricValue(detail.variance, detail.metric_key, currency)}
                      </p>
                    </div>
                  </div>

                  {/* Last Week / Trend -- present only for metrics that carry them (commercial-shaped metrics) */}
                  {(detail.last_week !== null && detail.last_week !== undefined || detail.trend) && (
                    <div className="flex items-center gap-5 text-sm rounded-md border border-border/60 p-3">
                      <span className="text-muted-foreground">
                        Last week: <span className="text-foreground font-medium tabular-nums">{formatMetricValue(detail.last_week, detail.metric_key, currency)}</span>
                      </span>
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        Trend: <TrendIcon trend={detail.trend ?? null} /> <span className="capitalize text-foreground">{formatTrendLabel(detail.trend)}</span>
                      </span>
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Explanation</h4>
                    <div className="space-y-2">
                      <p className="text-sm leading-relaxed text-foreground">{detail.explanation}</p>
                      {detail.what_changed && (
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          <span className="font-medium text-foreground">What changed: </span>{detail.what_changed}
                        </p>
                      )}
                      {detail.reconciliation_note && (
                        <p className="text-sm leading-relaxed text-rose-700">{detail.reconciliation_note}</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Territory Breakdown</h4>
                    {detail.by_territory.length > 0 ? (
                      <div className="rounded-md border border-border/60 overflow-hidden">
                        <Table>
                          <TableHeader className="bg-muted/20">
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="py-2 h-9 text-xs">Territory</TableHead>
                              <TableHead className="py-2 h-9 text-xs text-right">Contribution</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.by_territory.map((t, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/30">
                                <TableCell className="py-2 text-sm">{t.territory_name}</TableCell>
                                <TableCell className="py-2 text-sm text-right font-medium tabular-nums">{formatMetricValue(t.value, detail.metric_key, currency)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No territory breakdown available for this metric.</p>
                    )}
                  </div>

                  {/* PAM contribution -- territories.owner_user_id resolved server-side; never a synthetic row without a real territory */}
                  {detail.pam_contribution.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">PAM contribution</h4>
                      <div className="rounded-md border border-border/60 overflow-hidden">
                        <Table>
                          <TableHeader className="bg-muted/20">
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="py-2 h-9 text-xs">Territory</TableHead>
                              <TableHead className="py-2 h-9 text-xs">PAM</TableHead>
                              <TableHead className="py-2 h-9 text-xs text-right">Value</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.pam_contribution.map((p, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/30">
                                <TableCell className="py-2 text-sm">{p.territory_name}</TableCell>
                                <TableCell className="py-2 text-sm text-muted-foreground">{p.pam_name ?? 'Unassigned'}</TableCell>
                                <TableCell className="py-2 text-sm text-right font-medium tabular-nums">{formatMetricValue(p.value, detail.metric_key, currency)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {detail.records.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Underlying records</h4>
                      <div className="rounded-md border border-border/60 overflow-hidden max-h-64 overflow-y-auto">
                        <Table>
                          <TableBody>
                            {detail.records.map((r, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/30">
                                <TableCell className="py-2 text-sm">{r.label}</TableCell>
                                <TableCell className="py-2 text-sm text-right text-muted-foreground">{r.date ? new Date(r.date).toLocaleDateString() : '--'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {(detail.data_source || detail.last_updated || (detail.fx && detail.fx.currency !== 'USD')) && (
                    <div className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-1.5">
                      {detail.data_source && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Data source: </span>{detail.data_source}
                        </p>
                      )}
                      {detail.last_updated && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Last updated: </span>{new Date(detail.last_updated).toLocaleString()}
                        </p>
                      )}
                      {detail.fx && detail.fx.currency !== 'USD' && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Currency: </span>
                          1 USD = {detail.fx.usd_to_currency_rate.toFixed(4)} {detail.fx.currency}
                          {detail.fx.as_of ? ` — Frankfurter reference rate as of ${detail.fx.as_of}` : ''}
                          {detail.fx.stale ? ' (reference rate could not be refreshed; showing the last stored rate)' : ''}
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No details available for this metric.</p>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
