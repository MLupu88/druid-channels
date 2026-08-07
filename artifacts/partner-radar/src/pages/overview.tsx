import React, { useState } from 'react';
import { 
  useGetHeadOfChannelsKpis, 
  useListTerritories, 
  useGetKpiDetails,
  getGetKpiDetailsQueryKey,
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
import { ArrowDown, ArrowUp, Minus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useUser } from '@/contexts/user-context';

function StatusBadge({ status }: { status: string }) {
  if (status === 'green' || status === 'on_track') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal">On track</Badge>;
  if (status === 'amber') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal">Needs attention</Badge>;
  if (status === 'red') return <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal">At risk</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function TrendIcon({ trend }: { trend: string }) {
  if (trend === 'up') return <ArrowUp className="h-4 w-4 text-emerald-600 inline" />;
  if (trend === 'down') return <ArrowDown className="h-4 w-4 text-rose-600 inline" />;
  return <Minus className="h-4 w-4 text-muted-foreground inline" />;
}

function DataStatusBadge({ status }: { status: string }) {
  if (status === 'CONNECTED') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal text-xs">Connected</Badge>;
  if (status === 'MANUAL') return <Badge variant="outline" className="text-sky-700 bg-sky-50 border-sky-200 font-normal text-xs">Manual</Badge>;
  if (status === 'DEMO') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal text-xs">Demo data</Badge>;
  return <Badge variant="outline" className="text-muted-foreground font-normal text-xs">Not connected</Badge>;
}

export default function Overview() {
  const { activeUser } = useUser();
  const [territory, setTerritory] = useState<string>('global');
  const [period, setPeriod] = useState<string>('q3');
  const [selectedKpi, setSelectedKpi] = useState<string | null>(null);

  const { data: territories } = useListTerritories();
  const { data: kpis, isLoading: isLoadingKpis } = useGetHeadOfChannelsKpis({ 
    territory: territory === 'global' ? null : territory, 
    period 
  });
  const detailParams = { metric_key: selectedKpi ?? '', territory: territory === 'global' ? null : territory, period };
  const { data: detail, isLoading: isLoadingDetail } = useGetKpiDetails(
    detailParams,
    { query: { enabled: Boolean(selectedKpi), queryKey: getGetKpiDetailsQueryKey(detailParams) } },
  );

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

            <Button
              variant="outline"
              className="bg-card"
              onClick={() => {
                const params = new URLSearchParams({ period });
                if (territory !== 'global') params.set('territory', territory);
                window.open(`/api/exports/quarterly-pptx?${params.toString()}`, '_blank');
              }}
            >
              Export quarterly report
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
                        <TableCell className="text-right tabular-nums">{row.current}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{row.target}</TableCell>
                        <TableCell><StatusBadge status={row.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Table 2: Weekly commercial performance */}
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
                        <TableCell className="text-right tabular-nums">{row.current}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{row.last_week}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{row.target}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <TrendIcon trend={row.trend} />
                            <span className="text-sm capitalize">{row.trend}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Table 3: Weekly channel marketing */}
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
                      <TableHead className="font-medium text-muted-foreground text-right">Last Week</TableHead>
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
                        <TableCell className="text-right tabular-nums">{row.this_week}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{row.last_week ?? '—'}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <TrendIcon trend={row.trend} />
                            <span className="text-sm capitalize">{row.trend}</span>
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
        <div className="w-[400px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)] transition-transform duration-300">
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
                    <DataStatusBadge status={detail.data_status} />
                    {detail.reconciles === false && (
                      <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal text-xs">Reconciliation mismatch</Badge>
                    )}
                  </div>

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
                                <TableCell className="py-2 text-sm text-right font-medium">{t.value}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No territory breakdown available for this metric.</p>
                    )}
                  </div>

                  {detail.records.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Underlying records</h4>
                      <div className="rounded-md border border-border/60 overflow-hidden max-h-64 overflow-y-auto">
                        <Table>
                          <TableBody>
                            {detail.records.map((r, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/30">
                                <TableCell className="py-2 text-sm">{r.label}</TableCell>
                                <TableCell className="py-2 text-sm text-right text-muted-foreground">{r.date ? new Date(r.date).toLocaleDateString() : '—'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {(detail.data_source || detail.last_updated) && (
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