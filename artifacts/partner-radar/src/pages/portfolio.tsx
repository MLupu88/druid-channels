import React, { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  useListPortfolio,
  getListPortfolioQueryKey,
  useGetPortfolioRelationship,
  getGetPortfolioRelationshipQueryKey,
  useGetPortfolioSummary,
  useUpdatePortfolioRelationship,
  useTransitionPortfolioStatus,
  useReassignPortfolioRelationship,
  useAddPortfolioActivity,
  useCreatePortfolioRelationship,
  useListTerritories,
  useListUsers,
  getListUsersQueryKey,
  useSearchCompanies,
  getSearchCompaniesQueryKey,
} from '@workspace/api-client-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PeriodSelector } from '@/components/period-selector';
import { getDefaultPeriodKey } from '@/lib/period';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, ExternalLink, Plus, Upload } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/auth-context';
import { WorkspaceSubNav } from '@/components/workspace-subnav';
import { getPartnersSubNavItems } from '@/lib/navigation';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const STATUS_LABELS: Record<string, string> = { active: 'Active', dormant: 'Dormant', closed: 'Closed' };
const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  meeting: 'Meeting',
  call: 'Call',
  review: 'Review',
  partner_update: 'Partner update',
  opportunity_discussion: 'Opportunity discussion',
  next_action: 'Next action',
  other: 'Other',
};
const PRECISION_LABELS: Record<string, string> = {
  exact_date: '',
  month: '(month)',
  quarter: '(quarter)',
  year: '(year, approx.)',
  unknown: '',
};

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dormant: 'bg-amber-50 text-amber-700 border-amber-200',
    closed: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  return <Badge variant="outline" className={`font-normal ${styles[status] ?? ''}`}>{STATUS_LABELS[status] ?? status}</Badge>;
}

function formatRelationshipAge(startedAt: string | null | undefined, precision: string): string {
  if (!startedAt) return 'Unknown';
  const label = new Date(startedAt).toLocaleDateString(undefined, precision === 'exact_date' ? undefined : { year: 'numeric', month: precision === 'year' ? undefined : 'short' });
  return `${label} ${PRECISION_LABELS[precision] ?? ''}`.trim();
}

export function PortfolioView({ territoryId, pamUserId }: { territoryId?: string; pamUserId?: string }) {
  const { user: activeUser, isGlobalUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: territories } = useListTerritories();
  // Admin-only endpoint -- a PAM must never trigger this call (it would
  // always 403 in the background). Only Head/Admin needs the PAM roster
  // (filters, reassignment picker).
  const { data: users } = useListUsers({ query: { enabled: isGlobalUser, queryKey: getListUsersQueryKey() } });

  // Canonical, not users.territory free text: a PAM's own territory is
  // whichever territories row has owner_user_id === their own id. Used to
  // auto-scope Manual Add (no visible picker for a PAM) and to detect the
  // "PAM owns no territory yet" blocking state.
  const myTerritory = !isGlobalUser ? territories?.find((t) => t.owner_user_id === activeUser?.id) : undefined;
  const territoriesLoaded = !!territories;
  const pamHasNoTerritory = !isGlobalUser && territoriesLoaded && !myTerritory;

  const [territory, setTerritory] = useState<string>(territoryId ?? 'all');
  const [pamFilter, setPamFilter] = useState<string>(pamUserId ?? 'all');
  const [status, setStatus] = useState<string>('all');
  const [period, setPeriod] = useState<string>(getDefaultPeriodKey());
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualAddOpen, setManualAddOpen] = useState(false);

  const listParams = {
    ...(isGlobalUser && territory !== 'all' ? { territory } : {}),
    ...(isGlobalUser && pamFilter !== 'all' ? { pam_user_id: pamFilter } : {}),
    ...(status !== 'all' ? { status } : {}),
    ...(search ? { search } : {}),
  };
  const { data: relationships, isLoading } = useListPortfolio(listParams);
  const { data: summary } = useGetPortfolioSummary({ period, ...(isGlobalUser && territory !== 'all' ? { territory } : {}) });

  const { data: detail, isLoading: isLoadingDetail } = useGetPortfolioRelationship(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetPortfolioRelationshipQueryKey(selectedId || '') } },
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPortfolioQueryKey() });
    if (selectedId) queryClient.invalidateQueries({ queryKey: getGetPortfolioRelationshipQueryKey(selectedId) });
  };

  const [editSummary, setEditSummary] = useState('');
  const [editNextAction, setEditNextAction] = useState('');
  const [editNextActionDue, setEditNextActionDue] = useState('');
  const openEditFields = () => {
    if (!detail) return;
    setEditSummary(detail.relationship_summary ?? '');
    setEditNextAction(detail.next_action ?? '');
    setEditNextActionDue(detail.next_action_due_at ?? '');
  };

  const updateMutation = useUpdatePortfolioRelationship({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: 'Saved' }); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not save', description: err?.message ?? 'Please try again.' }),
    },
  });
  const statusMutation = useTransitionPortfolioStatus({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: 'Status updated' }); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not update status', description: err?.message ?? 'Please try again.' }),
    },
  });
  const reassignMutation = useReassignPortfolioRelationship({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: 'Reassigned' }); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not reassign', description: err?.message ?? 'Please try again.' }),
    },
  });
  const activityMutation = useAddPortfolioActivity({
    mutation: {
      onSuccess: () => { invalidate(); setActivityNote(''); toast({ title: 'Activity logged' }); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not log activity', description: err?.message ?? 'Please try again.' }),
    },
  });

  const [activityType, setActivityType] = useState('meeting');
  const [activityNote, setActivityNote] = useState('');
  const [activityDate, setActivityDate] = useState(() => new Date().toISOString().slice(0, 10));

  const handleSaveFields = () => {
    if (!selectedId) return;
    updateMutation.mutate({
      id: selectedId,
      data: { relationship_summary: editSummary.trim() || null, next_action: editNextAction.trim() || null, next_action_due_at: editNextActionDue || null },
    });
  };

  const handleLogActivity = () => {
    if (!selectedId || !activityNote.trim()) return;
    activityMutation.mutate({
      id: selectedId,
      data: { activity_type: activityType as any, note: activityNote.trim(), occurred_at: new Date(activityDate).toISOString() },
    });
  };

  // A PAM with no canonical territory (territories.owner_user_id) cannot
  // have a meaningful Portfolio -- block clearly rather than silently
  // showing an empty/broken workspace or a permanently-disabled Add form.
  if (pamHasNoTerritory) {
    return (
      <div className="p-6">
        <Card className="shadow-none border-amber-200 bg-amber-50 max-w-lg">
          <CardContent className="p-5 space-y-1">
            <p className="font-medium text-amber-900">No territory assigned</p>
            <p className="text-sm text-amber-800">
              Your account has no canonical territory yet, so there is no Portfolio to show. Contact an admin to have a territory assigned to you.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <WorkspaceSubNav items={getPartnersSubNavItems(isGlobalUser)} />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {isGlobalUser ? 'What is happening across the channel organization.' : 'What you need to do with your partners.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <PeriodSelector value={period} onChange={setPeriod} />
            <Link href="/portfolio/import">
              <Button variant="outline" size="sm" className="gap-1.5"><Upload className="h-4 w-4" /> Import my book</Button>
            </Link>
            <Button size="sm" className="gap-1.5" onClick={() => setManualAddOpen(true)}><Plus className="h-4 w-4" /> Add partner</Button>
          </div>
        </div>

        {summary && (
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Active partners', value: summary.active_partners },
              { label: `New in ${summary.period}`, value: summary.new_partners_in_period },
              { label: 'In recruitment', value: summary.in_recruitment },
              { label: 'Needs attention', value: summary.needs_attention },
            ].map((c) => (
              <Card key={c.label} className="shadow-none border-border/70">
                <CardContent className="p-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{c.label}</p>
                  <p className="text-2xl font-semibold tabular-nums mt-1">{c.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company..." className="w-[220px] h-8 bg-background border-border/60" />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[150px] h-8 bg-background border-border/60"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
          {isGlobalUser && (
            <>
              <Select value={territory} onValueChange={setTerritory}>
                <SelectTrigger className="w-[180px] h-8 bg-background border-border/60"><SelectValue placeholder="Territory" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All territories</SelectItem>
                  {territories?.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={pamFilter} onValueChange={setPamFilter}>
                <SelectTrigger className="w-[180px] h-8 bg-background border-border/60"><SelectValue placeholder="PAM" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All PAMs</SelectItem>
                  {users?.filter((u) => u.role === 'pam').map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          )}
        </div>

        <Card className="shadow-none border-border/70">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Company</TableHead>
                  <TableHead>Territory</TableHead>
                  <TableHead>PAM</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Relationship since</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead>Next action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ) : relationships && relationships.length > 0 ? (
                  relationships.map((r) => (
                    <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setSelectedId(r.id)}>
                      <TableCell className="font-medium">{r.company.name}</TableCell>
                      <TableCell className="text-muted-foreground">{r.territory_name ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{r.assigned_user?.name ?? 'Unassigned'}</TableCell>
                      <TableCell className="text-muted-foreground">{r.partner_type ?? '—'}</TableCell>
                      <TableCell><StatusBadge status={r.status} /></TableCell>
                      <TableCell className="text-muted-foreground">{formatRelationshipAge(r.relationship_started_at, r.started_at_precision)}</TableCell>
                      <TableCell className="text-muted-foreground">{r.last_interaction_at ? new Date(r.last_interaction_at).toLocaleDateString() : 'Never'}</TableCell>
                      <TableCell className="text-muted-foreground max-w-[160px] truncate">{r.next_action || '—'}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No partners in the portfolio yet -- import your book or add one manually.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {selectedId && (
        <div className="w-[440px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-muted/10">
            <h3 className="font-medium truncate">{detail?.company.name ?? 'Partner'}</h3>
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
                    <StatusBadge status={detail.status} />
                    {detail.strategic_importance && <Badge variant="outline" className="font-normal">{detail.strategic_importance} priority</Badge>}
                    {detail.company.domain ? (
                      <a href={`https://${detail.company.domain}`} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline flex items-center gap-1 ml-auto">
                        {detail.company.domain} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground ml-auto">No domain on file</span>
                    )}
                  </div>

                  <Link href={`/opportunities?company=${detail.company.id}`} className="text-xs text-primary hover:underline inline-block">
                    View opportunities for {detail.company.name} →
                  </Link>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Territory</p>
                      <p className="font-medium">{detail.territory_name ?? '—'}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">PAM</p>
                      <p className="font-medium">{detail.assigned_user?.name ?? 'Unassigned'}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Relationship since</p>
                      <p className="font-medium">{formatRelationshipAge(detail.relationship_started_at, detail.started_at_precision)}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Origin</p>
                      <p className="font-medium capitalize">{detail.origin_type.replace('_', ' ')}</p>
                    </div>
                  </div>

                  {detail.context?.related_recruitment && (
                    <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
                      Also in Recruitment: stage <span className="font-medium">{detail.context.related_recruitment.stage.replace('_', ' ')}</span>
                    </div>
                  )}
                  {detail.context?.related_radar_signals && detail.context.related_radar_signals.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Recent Radar signals</h4>
                      <div className="space-y-2">
                        {detail.context.related_radar_signals.map((s) => (
                          <div key={s.id} className="text-xs rounded-md border border-border/60 p-2.5">
                            <p className="font-medium text-foreground">{s.headline}</p>
                            <p className="text-muted-foreground mt-0.5">{s.signal_type.replace('_', ' ')} · {new Date(s.discovered_at).toLocaleDateString()}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Summary &amp; next action</h4>
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs mb-1.5 block">Relationship summary</Label>
                        <Textarea value={editSummary || detail.relationship_summary || ''} onChange={(e) => setEditSummary(e.target.value)} onFocus={openEditFields} className="text-sm" />
                      </div>
                      <div>
                        <Label className="text-xs mb-1.5 block">Next action</Label>
                        <Input value={editNextAction || detail.next_action || ''} onChange={(e) => setEditNextAction(e.target.value)} onFocus={openEditFields} placeholder="e.g. Schedule QBR" />
                      </div>
                      <div>
                        <Label className="text-xs mb-1.5 block">Due date</Label>
                        <Input type="date" value={editNextActionDue || detail.next_action_due_at || ''} onChange={(e) => setEditNextActionDue(e.target.value)} onFocus={openEditFields} />
                      </div>
                      <Button size="sm" variant="outline" onClick={handleSaveFields} disabled={updateMutation.isPending}>Save</Button>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Status</h4>
                    <div className="flex items-center gap-2 flex-wrap">
                      {detail.status === 'active' && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => statusMutation.mutate({ id: selectedId, data: { status: 'dormant' } })} disabled={statusMutation.isPending}>Mark dormant</Button>
                          <Button size="sm" variant="outline" className="text-rose-600 hover:text-rose-600 hover:bg-rose-50" onClick={() => statusMutation.mutate({ id: selectedId, data: { status: 'closed' } })} disabled={statusMutation.isPending}>Close</Button>
                        </>
                      )}
                      {detail.status === 'dormant' && (
                        <>
                          <Button size="sm" onClick={() => statusMutation.mutate({ id: selectedId, data: { status: 'active' } })} disabled={statusMutation.isPending}>Reactivate</Button>
                          <Button size="sm" variant="outline" className="text-rose-600 hover:text-rose-600 hover:bg-rose-50" onClick={() => statusMutation.mutate({ id: selectedId, data: { status: 'closed' } })} disabled={statusMutation.isPending}>Close</Button>
                        </>
                      )}
                      {detail.status === 'closed' && (
                        <Button size="sm" onClick={() => statusMutation.mutate({ id: selectedId, data: { status: 'active' } })} disabled={statusMutation.isPending}>Reactivate</Button>
                      )}
                    </div>
                  </div>

                  {isGlobalUser && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Reassign owner</h4>
                      <Select value={detail.assigned_user?.id ?? 'none'} onValueChange={(v) => reassignMutation.mutate({ id: selectedId, data: { assigned_user_id: v === 'none' ? null : v } })}>
                        <SelectTrigger className="h-8"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Unassigned</SelectItem>
                          {users?.filter((u) => u.role === 'pam').map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Log activity</h4>
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <Select value={activityType} onValueChange={setActivityType}>
                          <SelectTrigger className="h-8 flex-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(ACTIVITY_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Input type="date" value={activityDate} onChange={(e) => setActivityDate(e.target.value)} className="h-8 w-[140px]" />
                      </div>
                      <Textarea value={activityNote} onChange={(e) => setActivityNote(e.target.value)} placeholder="What happened?" className="text-sm" />
                      <Button size="sm" onClick={handleLogActivity} disabled={activityMutation.isPending || !activityNote.trim()}>Log activity</Button>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Activity timeline</h4>
                    <div className="space-y-2">
                      {detail.activities.length === 0 && <p className="text-xs text-muted-foreground">No activity logged yet.</p>}
                      {detail.activities.map((a) => (
                        <div key={a.id} className="text-xs rounded-md border border-border/60 p-2.5">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-foreground">{ACTIVITY_TYPE_LABELS[a.activity_type] ?? a.activity_type}</span>
                            <span className="text-muted-foreground">{new Date(a.occurred_at).toLocaleDateString()}</span>
                          </div>
                          {a.actor_name && <p className="text-muted-foreground mt-0.5">by {a.actor_name}</p>}
                          <p className="text-foreground mt-1">{a.note}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">History</h4>
                    <div className="space-y-2">
                      {detail.history.map((h) => (
                        <div key={h.id} className="text-xs rounded-md border border-border/60 p-2.5">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-foreground capitalize">{h.event_type.replace('_', ' ')}</span>
                            <span className="text-muted-foreground">{new Date(h.occurred_at).toLocaleDateString()}</span>
                          </div>
                          {h.changed_by_name && <p className="text-muted-foreground mt-0.5">by {h.changed_by_name}</p>}
                          {h.note && <p className="text-foreground mt-1">{h.note}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      <ManualAddDialog
        open={manualAddOpen}
        onOpenChange={setManualAddOpen}
        defaultTerritoryId={territoryId ?? myTerritory?.id}
        onCreated={() => { invalidate(); }}
      />
    </div>
  );
}

function ManualAddDialog({ open, onOpenChange, defaultTerritoryId, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; defaultTerritoryId?: string; onCreated: () => void }) {
  const { isGlobalUser, user } = useAuth();
  const { toast } = useToast();
  const { data: territories } = useListTerritories();
  const [territoryId, setTerritoryId] = useState(defaultTerritoryId ?? '');
  // defaultTerritoryId (the PAM's own canonical territory) may resolve
  // after this dialog first mounts (territories still loading) -- keep it
  // in sync rather than freezing the empty initial value forever.
  React.useEffect(() => {
    if (defaultTerritoryId && !territoryId) setTerritoryId(defaultTerritoryId);
  }, [defaultTerritoryId]);
  const [companyQuery, setCompanyQuery] = useState('');
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [newCompanyName, setNewCompanyName] = useState('');
  const [newCompanyDomain, setNewCompanyDomain] = useState('');
  const [newCompanyCountry, setNewCompanyCountry] = useState('');
  const [partnerType, setPartnerType] = useState('');
  const [startedAt, setStartedAt] = useState('');

  const { data: companyResults } = useSearchCompanies(
    { q: companyQuery },
    { query: { enabled: companyQuery.trim().length >= 2, queryKey: getSearchCompaniesQueryKey({ q: companyQuery }) } },
  );

  const createMutation = useCreatePortfolioRelationship({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Partner added' });
        onOpenChange(false);
        onCreated();
        setSelectedCompanyId(null);
        setCompanyQuery('');
        setNewCompanyName('');
        setNewCompanyDomain('');
        setNewCompanyCountry('');
        setPartnerType('');
        setStartedAt('');
      },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not add partner', description: err?.message ?? 'Please try again.' }),
    },
  });

  const canSubmit = !!territoryId && (!!selectedCompanyId || (!!newCompanyName.trim() && !!newCompanyCountry.trim()));

  const handleSubmit = () => {
    if (!canSubmit) return;
    createMutation.mutate({
      data: {
        territory_id: territoryId,
        ...(selectedCompanyId ? { company_id: selectedCompanyId } : { new_company: { name: newCompanyName.trim(), domain: newCompanyDomain.trim() || null, country: newCompanyCountry.trim() } }),
        partner_type: partnerType.trim() || null,
        relationship_started_at: startedAt || null,
        started_at_precision: startedAt ? 'exact_date' : 'unknown',
        started_at_provenance: startedAt ? 'explicit' : null,
        assigned_user_id: !isGlobalUser ? user?.id : undefined,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader><DialogTitle>Add partner</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          {isGlobalUser && (
            <div>
              <Label className="text-xs mb-1.5 block">Territory</Label>
              <Select value={territoryId} onValueChange={setTerritoryId}>
                <SelectTrigger><SelectValue placeholder="Select territory" /></SelectTrigger>
                <SelectContent>
                  {territories?.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label className="text-xs mb-1.5 block">Company</Label>
            <Input
              value={selectedCompanyId ? companyQuery : companyQuery}
              onChange={(e) => { setCompanyQuery(e.target.value); setSelectedCompanyId(null); }}
              placeholder="Search existing companies..."
            />
            {!selectedCompanyId && companyResults && companyResults.length > 0 && (
              <div className="mt-1 border border-border/60 rounded-md divide-y max-h-[140px] overflow-auto">
                {companyResults.map((c) => (
                  <button key={c.id} type="button" className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted/50" onClick={() => { setSelectedCompanyId(c.id); setCompanyQuery(c.name); }}>
                    {c.name} <span className="text-muted-foreground">({c.domain ?? 'no domain'})</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {!selectedCompanyId && (
            <div className="rounded-md border border-dashed border-border/70 p-3 space-y-2">
              <p className="text-xs text-muted-foreground">No match? Create a new company:</p>
              <Input value={newCompanyName} onChange={(e) => setNewCompanyName(e.target.value)} placeholder="Company name" />
              <Input value={newCompanyDomain} onChange={(e) => setNewCompanyDomain(e.target.value)} placeholder="Domain (optional)" />
              <Input value={newCompanyCountry} onChange={(e) => setNewCompanyCountry(e.target.value)} placeholder="Country (required)" />
            </div>
          )}
          <div>
            <Label className="text-xs mb-1.5 block">Partner type</Label>
            <Input value={partnerType} onChange={(e) => setPartnerType(e.target.value)} placeholder="e.g. Reseller, System Integrator" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Relationship started (if known)</Label>
            <Input type="date" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || createMutation.isPending}>Add partner</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Portfolio() {
  return <PortfolioView />;
}
