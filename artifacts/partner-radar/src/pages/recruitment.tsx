import React, { useState, useMemo } from 'react';
import {
  useListRecruitments,
  getListRecruitmentsQueryKey,
  useGetRecruitment,
  getGetRecruitmentQueryKey,
  useTransitionRecruitment,
  useUpdateRecruitment,
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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, ExternalLink, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const STAGE_LABELS: Record<string, string> = {
  accepted: 'Accepted',
  contacting: 'Contacting',
  engaged: 'Engaged',
  agreement: 'Agreement',
  signed: 'Signed',
  on_hold: 'On Hold',
  not_pursuing: 'Not Pursuing',
};

// Headline summary cards -- On Hold/Not Pursuing are exception states, not
// part of the primary funnel, so they're deliberately excluded here.
const SUMMARY_STAGES = ['accepted', 'contacting', 'engaged', 'agreement', 'signed'] as const;

const NOT_PURSUING_REASONS = [
  { value: 'no_strategic_fit', label: 'No strategic fit' },
  { value: 'no_capacity', label: 'No capacity' },
  { value: 'competitor_conflict', label: 'Competitor conflict' },
  { value: 'no_response', label: 'No response' },
  { value: 'geography_mismatch', label: 'Geography mismatch' },
  { value: 'other', label: 'Other' },
];

function StageBadge({ stage }: { stage: string }) {
  const styles: Record<string, string> = {
    accepted: 'bg-slate-50 text-slate-700 border-slate-200',
    contacting: 'bg-blue-50 text-blue-700 border-blue-200',
    engaged: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    agreement: 'bg-violet-50 text-violet-700 border-violet-200',
    signed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    on_hold: 'bg-amber-50 text-amber-700 border-amber-200',
    not_pursuing: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  return <Badge variant="outline" className={`font-normal ${styles[stage] ?? ''}`}>{STAGE_LABELS[stage] ?? stage}</Badge>;
}

function PriorityBadge({ priority }: { priority: string }) {
  return priority === 'A'
    ? <Badge variant="outline" className="font-normal bg-emerald-50 text-emerald-700 border-emerald-200">Priority A</Badge>
    : <Badge variant="outline" className="font-normal bg-amber-50 text-amber-700 border-amber-200">Priority B</Badge>;
}

function StalledBadge() {
  return (
    <Badge variant="outline" className="font-normal bg-rose-50 text-rose-700 border-rose-200 gap-1">
      <AlertTriangle className="h-3 w-3" /> Stalled
    </Badge>
  );
}

export default function Recruitment() {
  const { user: activeUser, isGlobalUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: territories } = useListTerritories();

  const [territory, setTerritory] = useState<string>('all');
  const [stage, setStage] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transitionNote, setTransitionNote] = useState('');
  const [notPursuingOpen, setNotPursuingOpen] = useState(false);
  const [notPursuingReason, setNotPursuingReason] = useState('');
  const [editNextStep, setEditNextStep] = useState('');
  const [editFollowUpDate, setEditFollowUpDate] = useState('');

  // Stage is deliberately NOT sent to the server -- the full scoped list is
  // fetched once so the summary cards always reflect every stage
  // regardless of which one the table is currently filtered to, with no
  // second round-trip when the filter changes.
  const { data: recruitments, isLoading } = useListRecruitments({
    ...(isGlobalUser && territory !== 'all' ? { territory } : {}),
    ...(search ? { search } : {}),
  });

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of recruitments ?? []) counts[r.stage] = (counts[r.stage] ?? 0) + 1;
    return counts;
  }, [recruitments]);

  const filteredRecruitments = useMemo(() => {
    if (stage === 'all') return recruitments ?? [];
    return (recruitments ?? []).filter((r) => r.stage === stage);
  }, [recruitments, stage]);

  const { data: detail, isLoading: isLoadingDetail } = useGetRecruitment(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetRecruitmentQueryKey(selectedId || '') } },
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListRecruitmentsQueryKey() });
    if (selectedId) queryClient.invalidateQueries({ queryKey: getGetRecruitmentQueryKey(selectedId) });
  };

  const transitionMutation = useTransitionRecruitment({
    mutation: {
      onSuccess: () => {
        invalidate();
        setTransitionNote('');
        setNotPursuingOpen(false);
        setNotPursuingReason('');
        toast({ title: 'Stage updated' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not update stage', description: err?.message ?? 'Please try again.' });
      },
    },
  });

  const updateMutation = useUpdateRecruitment({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Recruitment updated' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not save changes', description: err?.message ?? 'Please try again.' });
      },
    },
  });

  const handleTransition = (toStage: string) => {
    if (!selectedId) return;
    transitionMutation.mutate({ id: selectedId, data: { to_stage: toStage as any, note: transitionNote.trim() || undefined } });
  };

  const handleNotPursuing = () => {
    if (!selectedId || !notPursuingReason) return;
    transitionMutation.mutate({
      id: selectedId,
      data: { to_stage: 'not_pursuing' as any, note: transitionNote.trim() || undefined, not_pursuing_reason: notPursuingReason as any },
    });
  };

  const openEditFields = () => {
    if (!detail) return;
    setEditNextStep(detail.next_step ?? '');
    setEditFollowUpDate(detail.follow_up_date ?? '');
  };

  const handleSaveFields = () => {
    if (!selectedId) return;
    updateMutation.mutate({
      id: selectedId,
      data: { next_step: editNextStep.trim() || null, follow_up_date: editFollowUpDate || null },
    });
  };

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Recruitment</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Accepted Discovery prospects, moving from first contact to Signed.
          </p>
        </div>

        <div className="grid grid-cols-5 gap-3">
          {SUMMARY_STAGES.map((s) => (
            <Card key={s} className="shadow-none border-border/70">
              <CardContent className="p-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{STAGE_LABELS[s]}</p>
                <p className="text-2xl font-semibold tabular-nums mt-1">{stageCounts[s] ?? 0}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company..."
            className="w-[220px] h-8 bg-background border-border/60"
          />
          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger className="w-[160px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {Object.entries(STAGE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isGlobalUser && (
            <Select value={territory} onValueChange={setTerritory}>
              <SelectTrigger className="w-[180px] h-8 bg-background border-border/60">
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
        </div>

        <Card className="shadow-none border-border/70">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Company</TableHead>
                  <TableHead>Territory</TableHead>
                  <TableHead>PAM</TableHead>
                  <TableHead>Fit</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Next step</TableHead>
                  <TableHead>Follow-up</TableHead>
                  <TableHead className="text-right">Days in stage</TableHead>
                  <TableHead>Last updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={9}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ) : filteredRecruitments.length > 0 ? (
                  filteredRecruitments.map((r) => (
                    <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setSelectedId(r.id)}>
                      <TableCell className="font-medium">{r.company.name}</TableCell>
                      <TableCell className="text-muted-foreground">{r.territory_name ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{r.assigned_user?.name ?? 'Unassigned'}</TableCell>
                      <TableCell><PriorityBadge priority={r.priority} /></TableCell>
                      <TableCell><StageBadge stage={r.stage} /></TableCell>
                      <TableCell className="text-muted-foreground max-w-[160px] truncate">{r.next_step || '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{r.follow_up_date ? new Date(r.follow_up_date).toLocaleDateString() : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div className="flex items-center justify-end gap-1.5">
                          {r.is_stalled && <StalledBadge />}
                          <span>{r.days_in_stage}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{new Date(r.updated_at).toLocaleDateString()}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow><TableCell colSpan={9} className="text-center py-12 text-muted-foreground">No recruitments yet -- accept a qualified Discovery prospect to start one.</TableCell></TableRow>
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
            <h3 className="font-medium truncate">{detail?.company.name ?? 'Recruitment'}</h3>
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
                    <StageBadge stage={detail.stage} />
                    <PriorityBadge priority={detail.priority} />
                    {detail.is_stalled && <StalledBadge />}
                    <a href={`https://${detail.company.domain}`} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline flex items-center gap-1 ml-auto">
                      {detail.company.domain} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>

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
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Days in stage</p>
                      <p className="font-medium tabular-nums">{detail.days_in_stage}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Partner type</p>
                      <p className="font-medium">{detail.partner_type}</p>
                    </div>
                  </div>

                  {detail.stage === 'not_pursuing' && detail.not_pursuing_reason && (
                    <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                      Not pursuing: {NOT_PURSUING_REASONS.find((r) => r.value === detail.not_pursuing_reason)?.label ?? detail.not_pursuing_reason}
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Discovery context</h4>
                    <div className="space-y-2 text-sm">
                      <p className="text-foreground leading-relaxed">{detail.why_it_fits}</p>
                      <p className="text-muted-foreground leading-relaxed">{detail.why_now}</p>
                    </div>
                  </div>

                  {detail.signals.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Evidence</h4>
                      <div className="space-y-2">
                        {detail.signals.map((s) => (
                          <a key={s.id} href={s.source_url} target="_blank" rel="noreferrer" className="block text-xs rounded-md border border-border/60 p-2.5 hover:bg-muted/40 transition-colors">
                            <p className="font-medium text-foreground flex items-center gap-1">{s.title} <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" /></p>
                            <p className="text-muted-foreground mt-0.5">{s.source_domain}</p>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Next step &amp; follow-up</h4>
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs mb-1.5 block">Next step</Label>
                        <Input value={editNextStep || detail.next_step || ''} onChange={(e) => setEditNextStep(e.target.value)} onFocus={openEditFields} placeholder="e.g. Send proposal" />
                      </div>
                      <div>
                        <Label className="text-xs mb-1.5 block">Follow-up date</Label>
                        <Input type="date" value={editFollowUpDate || detail.follow_up_date || ''} onChange={(e) => setEditFollowUpDate(e.target.value)} onFocus={openEditFields} />
                      </div>
                      <Button size="sm" variant="outline" onClick={handleSaveFields} disabled={updateMutation.isPending}>Save</Button>
                    </div>
                  </div>

                  {detail.stage !== 'signed' && detail.stage !== 'not_pursuing' && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Update stage</h4>
                      <div className="space-y-3">
                        <Textarea
                          value={transitionNote}
                          onChange={(e) => setTransitionNote(e.target.value)}
                          placeholder="Note (optional)"
                          className="text-sm"
                        />
                        <div className="flex items-center gap-2 flex-wrap">
                          {detail.stage === 'on_hold' ? (
                            detail.previous_stage && (
                              <Button size="sm" onClick={() => handleTransition(detail.previous_stage!)} disabled={transitionMutation.isPending}>
                                Resume ({STAGE_LABELS[detail.previous_stage]})
                              </Button>
                            )
                          ) : (
                            <>
                              {detail.next_stage_action && (
                                <Button size="sm" onClick={() => handleTransition(detail.next_stage_action!.stage)} disabled={transitionMutation.isPending}>
                                  {detail.next_stage_action.label}
                                </Button>
                              )}
                              <Button size="sm" variant="outline" onClick={() => handleTransition('on_hold')} disabled={transitionMutation.isPending}>
                                Put on hold
                              </Button>
                              <Button size="sm" variant="outline" className="text-rose-600 hover:text-rose-600 hover:bg-rose-50" onClick={() => setNotPursuingOpen(true)} disabled={transitionMutation.isPending}>
                                Stop pursuing
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">History</h4>
                    <div className="space-y-2">
                      {detail.history.map((h) => (
                        <div key={h.id} className="text-xs rounded-md border border-border/60 p-2.5">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-foreground">{STAGE_LABELS[h.to_stage] ?? h.to_stage}</span>
                            <span className="text-muted-foreground">{new Date(h.created_at).toLocaleString()}</span>
                          </div>
                          {h.actor_name && <p className="text-muted-foreground mt-0.5">by {h.actor_name}</p>}
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

      <Dialog open={notPursuingOpen} onOpenChange={setNotPursuingOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Stop pursuing {detail?.company.name}?</DialogTitle>
            <DialogDescription>This is a terminal state. A reason is required.</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-xs mb-1.5 block">Reason</Label>
            <Select value={notPursuingReason} onValueChange={setNotPursuingReason}>
              <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
              <SelectContent>
                {NOT_PURSUING_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNotPursuingOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleNotPursuing} disabled={!notPursuingReason || transitionMutation.isPending}>
              Stop pursuing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
