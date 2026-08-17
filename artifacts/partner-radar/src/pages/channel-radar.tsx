import React, { useState, useMemo, useEffect } from 'react';
import {
  useListChannelRadarSignals,
  getListChannelRadarSignalsQueryKey,
  useGetChannelRadarSignal,
  getGetChannelRadarSignalQueryKey,
  useUpdateChannelRadarSignal,
  useRunChannelRadar,
  useListTerritories,
  useGetChannelRadarSummary,
  getGetChannelRadarSummaryQueryKey,
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
import { InterpretationBlock } from '@/components/interpretation-block';
import { X, ExternalLink, Loader2, Satellite, ShieldAlert, Link2, ChevronLeft, ChevronRight, Rows3, Ungroup } from 'lucide-react';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { computeRunRadarButtonState } from '@/lib/channel-radar-run';
import { groupSignalsByEntity, computeListPageRange, formatRadarSignalDate } from '@/lib/channel-radar-group';
import { PageHeader } from '@/components/page-header';
import { statusTone } from '@/lib/status-tone';

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
  partner_program: 'Partner program',
  tender_rfp: 'Tender/RFP',
  other: 'Other',
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  competitor: 'Competitor',
  partner: 'Partner',
  ecosystem: 'Ecosystem',
  technology_vendor: 'Technology vendor',
  other: 'Other',
};

const PAGE_SIZE = 50;

function ImplicationBadge({ implication }: { implication: string }) {
  const styles: Record<string, string> = {
    opportunity: statusTone('success'),
    threat: statusTone('danger'),
    watch: statusTone('warning'),
    neutral: statusTone('neutral'),
  };
  const labels: Record<string, string> = { opportunity: 'Opportunity', threat: 'Threat', watch: 'Watch', neutral: 'Neutral' };
  return <Badge variant="outline" className={`font-normal ${styles[implication] ?? ''}`}>{labels[implication] ?? implication}</Badge>;
}

function ImpactBadge({ impact }: { impact: string }) {
  const styles: Record<string, string> = {
    high: statusTone('danger'),
    medium: statusTone('warning'),
    low: statusTone('neutral'),
  };
  return <Badge variant="outline" className={`font-normal capitalize ${styles[impact] ?? ''}`}>{impact}</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    new: statusTone('info'),
    reviewed: statusTone('neutral'),
    // Deliberately not statusTone('neutral') -- the faded text (slate-400
    // vs. neutral's slate-700) is what visually signals "dismissed", not
    // just another neutral status.
    dismissed: 'bg-slate-50 text-slate-400 border-slate-200',
  };
  return <Badge variant="outline" className={`font-normal capitalize ${styles[status] ?? ''}`}>{status}</Badge>;
}

// Phase 11.6F: migrated from a hand-copied orange literal to the shared
// 11.6A --attention token -- same "needs validation" meaning
// (requires_validation, computed server-side, unchanged), only the color
// source changed.
function ValidationBadge() {
  return (
    <Badge variant="outline" className="font-normal bg-attention/10 text-attention border-attention-border gap-1">
      <ShieldAlert className="h-3 w-3" /> Needs validation
    </Badge>
  );
}

interface RadarSignalRow {
  id: string;
  entity_name: string;
  territory_name: string | null;
  signal_type: string;
  impact: string;
  implication: string;
  headline: string;
  recommended_action: string;
  discovered_at: string;
  last_evidence_at: string;
  source_published_at: string | null;
  evidence_count: number;
  requires_validation: boolean;
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
  const [entityType, setEntityType] = useState<string>('all');
  const [implication, setImplication] = useState<string>('all');
  const [impact, setImpact] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [requiresValidation, setRequiresValidation] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [groupByEntity, setGroupByEntity] = useState(false);

  // Every filter resets pagination back to page 0 -- a stale offset into a
  // now-different filtered set would otherwise silently show the wrong page.
  const resetToFirstPage = () => setPage(0);

  // The one filter object both the list and summary requests are built
  // from -- they can never silently diverge on what "the active filters"
  // are, since both literally spread the same source object (mirrors the
  // backend's shared applyChannelRadarFilters). limit/offset are added only
  // for the list call below -- summary is never paginated.
  const territoryFilterParams = isGlobalUser && territory !== 'all' ? { territory } : {};
  const filterParams = {
    ...territoryFilterParams,
    ...(signalType !== 'all' ? { signal_type: signalType } : {}),
    ...(entityType !== 'all' ? { entity_type: entityType } : {}),
    ...(implication !== 'all' ? { implication } : {}),
    ...(impact !== 'all' ? { impact } : {}),
    ...(status !== 'all' ? { status } : {}),
    ...(requiresValidation !== 'all' ? { requires_validation: requiresValidation } : {}),
    ...(search ? { search } : {}),
  };
  const listParams = { ...filterParams, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const { data: signals, isLoading } = useListChannelRadarSignals(listParams, {
    query: { queryKey: getListChannelRadarSignalsQueryKey(listParams) },
  });

  // Server-side aggregate under the SAME active filters as the list above --
  // correct regardless of which page is currently loaded, and the source of
  // truth for pagination's real total (see computeListPageRange below), not
  // just for the summary tiles.
  const { data: summary } = useGetChannelRadarSummary(filterParams, {
    query: { queryKey: getGetChannelRadarSummaryQueryKey(filterParams) },
  });

  const rows: RadarSignalRow[] = (signals ?? []) as RadarSignalRow[];
  // total is undefined only while summary's first request is still in
  // flight -- computeListPageRange treats that as "next page unproven",
  // never as "infinite more pages" (see its own comment).
  const { start: rangeStart, end: rangeEnd, hasPreviousPage, hasNextPage } = computeListPageRange(page, PAGE_SIZE, rows.length, summary?.total);

  // Safety net: if filters/data change out from under an already-loaded
  // page (e.g. an admin dismisses signals elsewhere, or a race between two
  // requests) and the current page comes back empty while page > 0, never
  // strand the user there -- drop back to page 0 automatically.
  useEffect(() => {
    if (!isLoading && rows.length === 0 && page > 0) {
      setPage(0);
    }
  }, [isLoading, rows.length, page]);

  const groupedRows = useMemo(() => (groupByEntity ? groupSignalsByEntity(rows) : null), [groupByEntity, rows]);

  const { data: detail, isLoading: isLoadingDetail } = useGetChannelRadarSignal(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetChannelRadarSignalQueryKey(selectedId || '') } },
  );
  const drawerDate = detail ? formatRadarSignalDate(detail) : null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListChannelRadarSignalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetChannelRadarSummaryQueryKey() });
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

  function renderRow(s: RadarSignalRow) {
    const dateCell = formatRadarSignalDate(s);
    return (
      <TableRow key={s.id} className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setSelectedId(s.id)}>
        <TableCell className="font-medium">
          <div className="flex items-center gap-1.5">
            {s.entity_name}
            {s.evidence_count > 1 && (
              <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" title={`${s.evidence_count} corroborating sources`}>
                <Link2 className="h-3 w-3" />{s.evidence_count}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground">{s.territory_name ?? '—'}</TableCell>
        <TableCell className="text-muted-foreground">{SIGNAL_TYPE_LABELS[s.signal_type] ?? s.signal_type}</TableCell>
        <TableCell><ImpactBadge impact={s.impact} /></TableCell>
        <TableCell><ImplicationBadge implication={s.implication} /></TableCell>
        <TableCell className="max-w-[220px] truncate text-muted-foreground">{s.headline}</TableCell>
        <TableCell className="max-w-[180px] truncate text-muted-foreground">{s.recommended_action}</TableCell>
        <TableCell>{s.requires_validation && <ValidationBadge />}</TableCell>
        <TableCell className="text-muted-foreground whitespace-nowrap">
          <span className="text-xs">{dateCell.label}</span> {new Date(dateCell.date).toLocaleDateString()}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <PageHeader
          title="Channel Radar"
          description="Competitive and ecosystem intelligence -- what changed, why it matters, and what to do about it."
          actions={
            runRadarButton.visible && (
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
            )
          }
        />

        <div className="grid grid-cols-5 gap-3">
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">New signals</p>
              <p className="text-2xl font-semibold tabular-nums mt-1">{summary?.by_status.new ?? '—'}</p>
            </CardContent>
          </Card>
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">High impact</p>
              <p className="text-2xl font-semibold tabular-nums mt-1">{summary?.by_impact.high ?? '—'}</p>
            </CardContent>
          </Card>
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Opportunities</p>
              <p className="text-2xl font-semibold tabular-nums mt-1 text-emerald-700">{summary?.by_implication.opportunity ?? '—'}</p>
            </CardContent>
          </Card>
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Threats</p>
              <p className="text-2xl font-semibold tabular-nums mt-1 text-rose-700">{summary?.by_implication.threat ?? '—'}</p>
            </CardContent>
          </Card>
          <Card className="shadow-none border-border/70">
            <CardContent className="p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Needs validation</p>
              <p className="text-2xl font-semibold tabular-nums mt-1 text-orange-700">{summary?.requires_validation_count ?? '—'}</p>
            </CardContent>
          </Card>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground w-full">
            The filters below only narrow the signals already discovered -- they don't run new research. Use Run Radar above for that.
          </p>
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetToFirstPage(); }}
            placeholder="Filter entity or headline..."
            title="Filters the signals already discovered below -- it does not run new Radar research. Use Run Radar for that."
            className="w-[220px] h-8 bg-background border-border/60"
          />
          {isGlobalUser && (
            <Select value={territory} onValueChange={(v) => { setTerritory(v); resetToFirstPage(); }}>
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
          <Select value={entityType} onValueChange={(v) => { setEntityType(v); resetToFirstPage(); }}>
            <SelectTrigger className="w-[160px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Entity type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All entity types</SelectItem>
              {Object.entries(ENTITY_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={signalType} onValueChange={(v) => { setSignalType(v); resetToFirstPage(); }}>
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
          <Select value={implication} onValueChange={(v) => { setImplication(v); resetToFirstPage(); }}>
            <SelectTrigger className="w-[150px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Implication" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All implications</SelectItem>
              <SelectItem value="opportunity">Opportunity</SelectItem>
              <SelectItem value="threat">Threat</SelectItem>
              <SelectItem value="watch">Watch</SelectItem>
              <SelectItem value="neutral">Neutral</SelectItem>
            </SelectContent>
          </Select>
          <Select value={impact} onValueChange={(v) => { setImpact(v); resetToFirstPage(); }}>
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
          <Select value={status} onValueChange={(v) => { setStatus(v); resetToFirstPage(); }}>
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
          <Select value={requiresValidation} onValueChange={(v) => { setRequiresValidation(v); resetToFirstPage(); }}>
            <SelectTrigger className="w-[160px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Validation" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All signals</SelectItem>
              <SelectItem value="true">Needs validation</SelectItem>
              <SelectItem value="false">No validation needed</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setGroupByEntity((g) => !g)}
            title={groupByEntity ? 'Show a flat list' : 'Group rows by entity'}
          >
            {groupByEntity ? <Ungroup className="h-3.5 w-3.5 mr-1.5" /> : <Rows3 className="h-3.5 w-3.5 mr-1.5" />}
            {groupByEntity ? 'Ungroup' : 'Group by entity'}
          </Button>
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
                  <TableHead>Review</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={9}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ) : rows.length > 0 ? (
                  groupedRows ? (
                    groupedRows.map(([entityName, entityRows]) => (
                      <React.Fragment key={entityName}>
                        <TableRow className="hover:bg-transparent bg-muted/30">
                          <TableCell colSpan={9} className="py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            {entityName} <span className="font-normal normal-case">· {entityRows.length} signal{entityRows.length === 1 ? '' : 's'}</span>
                          </TableCell>
                        </TableRow>
                        {entityRows.map(renderRow)}
                      </React.Fragment>
                    ))
                  ) : (
                    rows.map(renderRow)
                  )
                ) : (
                  <TableRow>
                    <TableCell colSpan={9} className="p-0">
                      <Empty className="border-none py-12">
                        <EmptyHeader>
                          <EmptyMedia variant="icon"><Satellite /></EmptyMedia>
                          <EmptyTitle>No signals yet</EmptyTitle>
                          <EmptyDescription>Run Radar for a territory to start.</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {(rows.length > 0 || page > 0) && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <p>{summary ? `Showing ${rangeStart}–${rangeEnd} of ${summary.total}` : `Showing ${rangeStart}–${rangeEnd}`}</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={!hasPreviousPage} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
              </Button>
              <Button variant="outline" size="sm" disabled={!hasNextPage} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        )}
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
                    {detail.requires_validation && <ValidationBadge />}
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
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{drawerDate!.label}</p>
                      <p className="font-medium">{new Date(drawerDate!.date).toLocaleDateString()}</p>
                      {/* Phase 11.6.1: the primary date above is always
                          explicitly labeled for what it is (a verified
                          article date, our own last-observed time, or our
                          own first-discovery time) -- never an unlabeled
                          date implying "this happened today." Any other
                          distinct date the signal carries is still shown,
                          but only as clearly-labeled secondary metadata. */}
                      {drawerDate!.label !== 'Last seen' && (
                        <p className="text-xs text-muted-foreground mt-0.5">Last seen {new Date(detail.last_evidence_at).toLocaleDateString()}</p>
                      )}
                      {drawerDate!.label !== 'First discovered' && detail.discovered_at !== detail.last_evidence_at && (
                        <p className="text-xs text-muted-foreground mt-0.5">First discovered {new Date(detail.discovered_at).toLocaleDateString()}</p>
                      )}
                    </div>
                  </div>

                  {(detail.related_entity_name || detail.relationship_label) && (
                    <div className="rounded-md border border-border/60 p-3 text-sm">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Related entity</p>
                      <p className="font-medium">
                        {detail.related_entity_name}
                        {detail.related_entity_type && <span className="text-muted-foreground font-normal"> · {ENTITY_TYPE_LABELS[detail.related_entity_type] ?? detail.related_entity_type}</span>}
                      </p>
                      {detail.relationship_label && <p className="text-muted-foreground mt-1">{detail.relationship_label}</p>}
                      {detail.related_entity_context?.relationship && (
                        <p className="text-emerald-700 mt-1.5">
                          Existing Partner ({detail.related_entity_context.relationship.status}) in {detail.related_entity_context.relationship.territory_name ?? 'this territory'}.
                        </p>
                      )}
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">{detail.headline}</h4>
                    <p className="text-sm text-foreground leading-relaxed">{detail.summary}</p>
                  </div>

                  {/* Phase 11.6F: AI interpretation, distinct from the
                      factual Evidence list below -- "why it matters" and
                      "recommended action" are the model's own reasoning, not
                      sourced facts. */}
                  <InterpretationBlock label="Why it matters">{detail.why_it_matters}</InterpretationBlock>
                  <InterpretationBlock label="Recommended action">{detail.recommended_action}</InterpretationBlock>

                  {/* Phase 11.6F: DRUID motion gets its OWN block (muted
                      purple-gray "DRUID knowledge" tone), no longer an
                      inline suffix line inside Recommended action -- it is
                      the one field in this payload that is explicitly
                      DRUID-context-informed (see channelRadarProviders/ai.ts
                      's DRUID_CONTEXT_FRAMING), so its origin deserves to
                      read separately from a generic recommendation. This is
                      still the model's own interpretation informed by
                      DRUID context, never a direct quote of a verified DRUID
                      fact -- labeled "DRUID motion", not "DRUID context" or
                      "Verified DRUID context", since no individual trusted
                      fact is being displayed here. */}
                  {detail.druid_partner_motion && (
                    <InterpretationBlock label="DRUID motion" tone="druid">{detail.druid_partner_motion}</InterpretationBlock>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">
                      Evidence {detail.evidence && detail.evidence.length > 1 && `(${detail.evidence.length} sources)`}
                    </h4>
                    <div className="space-y-1.5">
                      {(detail.evidence ?? []).map((e) => (
                        <a
                          key={e.id}
                          href={e.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="block text-xs rounded-md border border-border/60 p-2.5 hover:bg-muted/40 transition-colors"
                        >
                          <p className="font-medium text-foreground flex items-center gap-1">
                            {e.source_title} <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                            {e.is_primary && <Badge variant="outline" className="font-normal ml-1 h-4 px-1 text-[10px]">Primary</Badge>}
                          </p>
                          <p className="text-muted-foreground mt-0.5">
                            {e.source_domain ?? e.source_url}
                            {e.source_published_at && ` · Published ${new Date(e.source_published_at).toLocaleDateString()}`}
                          </p>
                        </a>
                      ))}
                    </div>
                  </div>

                  {/* Phase 10: PAM Channel Radar access is read-only -- these
                      review/dismiss actions call PATCH /channel-radar/:id,
                      which stays Head/Admin-only regardless of territory
                      ownership. Hidden here rather than just disabled, since
                      a PAM must never be offered an action they can never
                      complete. */}
                  {isGlobalUser && detail.status !== 'dismissed' && (
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
