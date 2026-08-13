import React, { useState, useMemo } from 'react';
import {
  useListChannelRadarSignals,
  getListChannelRadarSignalsQueryKey,
  useGetChannelRadarSignal,
  getGetChannelRadarSignalQueryKey,
  useUpdateChannelRadarSignal,
  useRunChannelRadar,
  useListTerritories,
} from '@workspace/api-client-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, ExternalLink, Loader2, Satellite } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { computeRunRadarButtonState } from '@/lib/channel-radar-run';

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  acquisition: 'Acquisition',
  partnership: 'Partnership',
  reseller_distributor: 'Reseller/Distributor',
  regional_expansion: 'Regional expansion',
  leadership_hire: 'Leadership hire',
  funding: 'Funding',
  customer_win: 'Customer win',
  product_gtm: 'Product/GTM',
  marketplace_listing: 'Marketplace listing',
  event: 'Event',
  other: 'Other',
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  competitor: 'Competitor',
  partner: 'Partner',
  ecosystem: 'Ecosystem',
  other: 'Other',
};

function ImplicationBadge({ implication }: { implication: string }) {
  const styles: Record<string, string> = {
    opportunity: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    threat: 'bg-rose-50 text-rose-700 border-rose-200',
    neutral: 'bg-slate-50 text-slate-700 border-slate-200',
  };
  const labels: Record<string, string> = { opportunity: 'Opportunity', threat: 'Threat', neutral: 'Neutral' };
  return <Badge variant="outline" className={`font-normal ${styles[implication] ?? ''}`}>{labels[implication] ?? implication}</Badge>;
}

function ImpactBadge({ impact }: { impact: string }) {
  const styles: Record<string, string> = {
    high: 'bg-rose-50 text-rose-700 border-rose-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    low: 'bg-slate-50 text-slate-700 border-slate-200',
  };
  return <Badge variant="outline" className={`font-normal capitalize ${styles[impact] ?? ''}`}>{impact}</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    new: 'bg-blue-50 text-blue-700 border-blue-200',
    reviewed: 'bg-slate-50 text-slate-700 border-slate-200',
    dismissed: 'bg-slate-50 text-slate-400 border-slate-200',
  };
  return <Badge variant="outline" className={`font-normal capitalize ${styles[status] ?? ''}`}>{status}</Badge>;
}

export default function ChannelRadar() {
  const { user: activeUser, isGlobalUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: territories } = useListTerritories();
  // Same "own territory" resolution pattern used on Overview -- the
  // server independently enforces this via assertRecordTerritoryAccess
  // regardless of what the client sends.
  const ownTerritoryId = !isGlobalUser ? territories?.find((t) => t.name === activeUser?.territory)?.id : undefined;

  const [territory, setTerritory] = useState<string>('all');
  const [signalType, setSignalType] = useState<string>('all');
  const [implication, setImplication] = useState<string>('all');
  const [impact, setImpact] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listParams = {
    ...(isGlobalUser && territory !== 'all' ? { territory } : {}),
    ...(signalType !== 'all' ? { signal_type: signalType } : {}),
    ...(implication !== 'all' ? { implication } : {}),
    ...(impact !== 'all' ? { impact } : {}),
    ...(status !== 'all' ? { status } : {}),
    ...(search ? { search } : {}),
  };
  const { data: signals, isLoading } = useListChannelRadarSignals(listParams, {
    query: { queryKey: getListChannelRadarSignalsQueryKey(listParams) },
  });

  const summary = useMemo(() => {
    const rows = signals ?? [];
    return {
      newCount: rows.filter((s) => s.status === 'new').length,
      highImpact: rows.filter((s) => s.impact === 'high').length,
      opportunities: rows.filter((s) => s.implication === 'opportunity').length,
      threats: rows.filter((s) => s.implication === 'threat').length,
    };
  }, [signals]);

  const { data: detail, isLoading: isLoadingDetail } = useGetChannelRadarSignal(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetChannelRadarSignalQueryKey(selectedId || '') } },
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListChannelRadarSignalsQueryKey() });
    if (selectedId) queryClient.invalidateQueries({ queryKey: getGetChannelRadarSignalQueryKey(selectedId) });
  };

  const updateMutation = useUpdateChannelRadarSignal({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Signal updated' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not update signal', description: err?.message ?? 'Please try again.' });
      },
    },
  });

  const runMutation = useRunChannelRadar({
    mutation: {
      onSuccess: (data) => {
        invalidate();
        toast({ title: 'Radar scan complete', description: data.message });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Radar scan failed', description: err?.message ?? 'Please try again.' });
      },
    },
  });

  // Global user must pick a specific territory before running; a PAM
  // always runs for their own territory (server-enforced regardless).
  const runTargetTerritoryId = isGlobalUser ? (territory !== 'all' ? territory : null) : (ownTerritoryId ?? null);
  const handleRunRadar = () => {
    if (runTargetTerritoryId) {
      runMutation.mutate({ data: { territory_id: runTargetTerritoryId } });
    }
  };
  const runRadarButton = computeRunRadarButtonState({
    isGlobalUser,
    territory,
    runTargetTerritoryId,
    isPending: runMutation.isPending,
  });

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Channel Radar</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Competitive and ecosystem intelligence -- what changed, why it matters, and what to do about it.
            </p>
          </div>
          {runRadarButton.visible && (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant="outline"
                onClick={handleRunRadar}
                disabled={runRadarButton.disabled}
                title={runRadarButton.title}
              >
                {runMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Satellite className="h-4 w-4 mr-2" />}
                {runMutation.isPending ? 'Running…' : 'Run Radar'}
              </Button>
              {runRadarButton.disabled && runRadarButton.title && (
                <p className="text-xs text-muted-foreground">{runRadarButton.title}</p>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">New signals</p>
              <p className="text-2xl font-semibold tabular-nums mt-1">{summary.newCount}</p>
            </CardContent>
          </Card>
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">High impact</p>
              <p className="text-2xl font-semibold tabular-nums mt-1">{summary.highImpact}</p>
            </CardContent>
          </Card>
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Opportunities</p>
              <p className="text-2xl font-semibold tabular-nums mt-1 text-emerald-700">{summary.opportunities}</p>
            </CardContent>
          </Card>
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Threats</p>
              <p className="text-2xl font-semibold tabular-nums mt-1 text-rose-700">{summary.threats}</p>
            </CardContent>
          </Card>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground w-full">
            The filters below only narrow the signals already discovered -- they don't run new research. Use Run Radar above for that.
          </p>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter entity or headline..."
            title="Filters the signals already discovered below -- it does not run new Radar research. Use Run Radar for that."
            className="w-[220px] h-8 bg-background border-border/60"
          />
          {isGlobalUser && (
            <Select value={territory} onValueChange={setTerritory}>
              <SelectTrigger className="w-[170px] h-8 bg-background border-border/60">
                <SelectValue placeholder="Territory" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All territories</SelectItem>
                {territories?.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={signalType} onValueChange={setSignalType}>
            <SelectTrigger className="w-[170px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Signal type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All signal types</SelectItem>
              {Object.entries(SIGNAL_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={implication} onValueChange={setImplication}>
            <SelectTrigger className="w-[150px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Implication" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All implications</SelectItem>
              <SelectItem value="opportunity">Opportunity</SelectItem>
              <SelectItem value="threat">Threat</SelectItem>
              <SelectItem value="neutral">Neutral</SelectItem>
            </SelectContent>
          </Select>
          <Select value={impact} onValueChange={setImpact}>
            <SelectTrigger className="w-[130px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Impact" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All impact</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[140px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="reviewed">Reviewed</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="shadow-none border-border/70">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Entity</TableHead>
                  <TableHead>Territory</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Impact</TableHead>
                  <TableHead>Implication</TableHead>
                  <TableHead>What happened</TableHead>
                  <TableHead>Recommended action</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ) : signals && signals.length > 0 ? (
                  signals.map((s) => (
                    <TableRow key={s.id} className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setSelectedId(s.id)}>
                      <TableCell className="font-medium">{s.entity_name}</TableCell>
                      <TableCell className="text-muted-foreground">{s.territory_name ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{SIGNAL_TYPE_LABELS[s.signal_type] ?? s.signal_type}</TableCell>
                      <TableCell><ImpactBadge impact={s.impact} /></TableCell>
                      <TableCell><ImplicationBadge implication={s.implication} /></TableCell>
                      <TableCell className="max-w-[240px] truncate text-muted-foreground">{s.headline}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">{s.recommended_action}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(s.discovered_at).toLocaleDateString()}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No signals yet -- run Radar for a territory to start.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Detail drawer */}
      {selectedId && (
        <div className="w-[440px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-muted/10">
            <h3 className="font-medium truncate">{detail?.entity_name ?? 'Signal'}</h3>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setSelectedId(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-5 space-y-6">
              {isLoadingDetail || !detail ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 flex-wrap">
                    <ImplicationBadge implication={detail.implication} />
                    <ImpactBadge impact={detail.impact} />
                    <StatusBadge status={detail.status} />
                    <Badge variant="outline" className="font-normal text-muted-foreground capitalize">{detail.confidence} confidence</Badge>
                  </div>

                  {detail.existing_partner_context?.relationship && (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                      Existing Partner ({detail.existing_partner_context.relationship.status}) in {detail.existing_partner_context.relationship.territory_name ?? 'this territory'}
                      {detail.existing_partner_context.relationship.assigned_user_name && ` -- owned by ${detail.existing_partner_context.relationship.assigned_user_name}`}. Consider expansion/protection, not a new recruitment.
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Entity type</p>
                      <p className="font-medium">{ENTITY_TYPE_LABELS[detail.entity_type] ?? detail.entity_type}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Territory</p>
                      <p className="font-medium">{detail.territory_name ?? '—'}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Signal type</p>
                      <p className="font-medium">{SIGNAL_TYPE_LABELS[detail.signal_type] ?? detail.signal_type}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Discovered</p>
                      <p className="font-medium">{new Date(detail.discovered_at).toLocaleDateString()}</p>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">{detail.headline}</h4>
                    <p className="text-sm text-foreground leading-relaxed">{detail.summary}</p>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Why DRUID should care</h4>
                    <p className="text-sm text-foreground leading-relaxed">{detail.why_it_matters}</p>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Recommended action</h4>
                    <p className="text-sm text-foreground leading-relaxed">{detail.recommended_action}</p>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Evidence</h4>
                    <a href={detail.source_url} target="_blank" rel="noreferrer" className="block text-xs rounded-md border border-border/60 p-2.5 hover:bg-muted/40 transition-colors">
                      <p className="font-medium text-foreground flex items-center gap-1">{detail.source_title} <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" /></p>
                      <p className="text-muted-foreground mt-0.5">
                        {detail.source_domain ?? detail.source_url}
                        {detail.source_published_at && ` · ${new Date(detail.source_published_at).toLocaleDateString()}`}
                      </p>
                    </a>
                  </div>

                  {detail.status !== 'dismissed' && (
                    <div className="flex items-center gap-2">
                      {detail.status === 'new' && (
                        <Button size="sm" onClick={() => updateMutation.mutate({ id: selectedId, data: { status: 'reviewed' } })} disabled={updateMutation.isPending}>
                          Mark Reviewed
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-rose-600 hover:text-rose-600 hover:bg-rose-50"
                        onClick={() => updateMutation.mutate({ id: selectedId, data: { status: 'dismissed' } })}
                        disabled={updateMutation.isPending}
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
