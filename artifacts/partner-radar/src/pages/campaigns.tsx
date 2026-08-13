import React, { useState } from 'react';
import {
  useListCampaigns,
  useCreateCampaign,
  useUpdateCampaign,
  useDeleteCampaign,
  useListTerritories,
  useListUsers,
  useListPartners,
  useListOpportunities,
  getListCampaignsQueryKey,
  getListUsersQueryKey,
  getListOpportunitiesQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/auth-context';
import { Plus, Pencil, Trash2, MoreVertical, ExternalLink } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type CampaignType =
  | 'joint_campaign'
  | 'event'
  | 'webinar'
  | 'training_enablement'
  | 'co_selling'
  | 'executive_roundtable'
  | 'other';

// Training & Enablement is ONE type, not two.
const TYPE_LABELS: Record<CampaignType, string> = {
  joint_campaign: 'Joint Campaign',
  event: 'Event / Conference',
  webinar: 'Webinar',
  training_enablement: 'Training & Enablement',
  co_selling: 'Co-selling / Account Activation',
  executive_roundtable: 'Executive Roundtable / Workshop',
  other: 'Other',
};

const TYPE_OPTIONS = Object.entries(TYPE_LABELS) as [CampaignType, string][];

function TypeBadge({ type }: { type: string }) {
  return <Badge variant="secondary" className="font-normal">{TYPE_LABELS[type as CampaignType] ?? type}</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    planned: "bg-blue-50 text-blue-700 border-blue-200",
    live: "bg-emerald-50 text-emerald-700 border-emerald-200",
    completed: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={`font-normal ${styles[status] || ""}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

function formatMoney(amount: { amount: number; currency: string } | null | undefined): string | null {
  if (!amount) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: amount.currency, maximumFractionDigits: 0 }).format(amount.amount);
  } catch {
    return `${amount.amount.toLocaleString()} ${amount.currency}`;
  }
}

function CommercialImpactCell({ campaign }: { campaign: { linked_opportunity_count: number; linked_open_pipeline?: { amount: number; currency: string } | null; linked_closed_revenue?: { amount: number; currency: string } | null } }) {
  if (!campaign.linked_opportunity_count) {
    return <span className="text-muted-foreground">—</span>;
  }
  const pipeline = formatMoney(campaign.linked_open_pipeline);
  const closed = formatMoney(campaign.linked_closed_revenue);
  return (
    <div className="text-xs space-y-0.5">
      <div className="font-medium text-foreground">{campaign.linked_opportunity_count} linked</div>
      {pipeline && <div className="text-muted-foreground">Pipeline {pipeline}</div>}
      {closed && <div className="text-muted-foreground">Closed {closed}</div>}
    </div>
  );
}

// Opportunity multi-select for the create/edit dialogs. Scoped to the
// activity's selected partner (opportunities from any other company are
// never offered) and to whatever the caller is authorized to see (the
// server enforces this too -- a PAM never gets another PAM's opportunities
// back from this list).
function OpportunityLinkPicker({
  partnerCompanyId,
  selectedIds,
  onChange,
}: {
  partnerCompanyId: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const enabled = Boolean(partnerCompanyId) && partnerCompanyId !== NONE_PARTNER;
  const params = { company_id: partnerCompanyId };
  const { data: opportunities, isLoading } = useListOpportunities(params, {
    query: { enabled, queryKey: getListOpportunitiesQueryKey(params) },
  });

  if (!enabled) {
    return <p className="text-sm text-muted-foreground">Select a partner to link opportunities.</p>;
  }
  if (isLoading) {
    return <Skeleton className="h-16 w-full" />;
  }
  if (!opportunities || opportunities.length === 0) {
    return <p className="text-sm text-muted-foreground">No opportunities found for this partner.</p>;
  }

  const toggle = (id: string) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  return (
    <div className="border border-border/60 rounded-md max-h-40 overflow-auto divide-y divide-border/50">
      {opportunities.map((o) => (
        <label key={o.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40">
          <Checkbox checked={selectedIds.includes(o.id)} onCheckedChange={() => toggle(o.id)} />
          <span className="flex-1 truncate">{o.name}</span>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {o.status} · {o.deal_value.toLocaleString()} {o.currency}
          </span>
        </label>
      ))}
    </div>
  );
}

const NONE_PARTNER = 'none';
const ALL = 'all';

export default function Campaigns() {
  const { user: activeUser, isGlobalUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [filterPartner, setFilterPartner] = useState(ALL);
  const [filterType, setFilterType] = useState<CampaignType | typeof ALL>(ALL);
  const [filterStatus, setFilterStatus] = useState<'planned' | 'live' | 'completed' | typeof ALL>(ALL);

  const listParams = {
    ...(filterPartner !== ALL ? { partner_company_id: filterPartner } : {}),
    ...(filterType !== ALL ? { type: filterType } : {}),
    ...(filterStatus !== ALL ? { status: filterStatus } : {}),
  };

  const { data: campaigns, isLoading, isError, refetch } = useListCampaigns(listParams, {
    query: { queryKey: getListCampaignsQueryKey(listParams) },
  });
  const { data: territories } = useListTerritories();
  const { data: users } = useListUsers({ query: { enabled: isGlobalUser, queryKey: getListUsersQueryKey() } });
  const { data: partners } = useListPartners();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Create form
  const [name, setName] = useState('');
  const [type, setType] = useState<CampaignType>('joint_campaign');
  const [territory, setTerritory] = useState('');
  const [owner, setOwner] = useState(activeUser?.id || '');
  const [partnerCompanyId, setPartnerCompanyId] = useState('');
  const [activityDate, setActivityDate] = useState('');
  const [notes, setNotes] = useState('');
  const [opportunityIds, setOpportunityIds] = useState<string[]>([]);

  // Edit form
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<CampaignType>('joint_campaign');
  const [editOwner, setEditOwner] = useState('');
  const [editStatus, setEditStatus] = useState<'planned' | 'live' | 'completed'>('planned');
  const [editPartnerCompanyId, setEditPartnerCompanyId] = useState(NONE_PARTNER);
  const [editActivityDate, setEditActivityDate] = useState('');
  const [editHubspotLink, setEditHubspotLink] = useState('');
  const [editMqls, setEditMqls] = useState('0');
  const [editPartnerReferrals, setEditPartnerReferrals] = useState('0');
  const [editNotes, setEditNotes] = useState('');
  const [editOpportunityIds, setEditOpportunityIds] = useState<string[]>([]);

  const activeCampaign = campaigns?.find(c => c.id === activeId) ?? null;

  const resetCreateForm = () => {
    setName('');
    setType('joint_campaign');
    setTerritory('');
    setOwner(activeUser?.id || '');
    setPartnerCompanyId('');
    setActivityDate('');
    setNotes('');
    setOpportunityIds([]);
  };

  const errorToast = (title: string) => (err: any) =>
    toast({ variant: 'destructive', title, description: err?.message ?? 'Please try again.' });

  const createMutation = useCreateCampaign({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        setCreateDialogOpen(false);
        resetCreateForm();
        toast({ title: 'Activity created' });
      },
      onError: errorToast('Could not create activity'),
    }
  });

  const handleCreate = () => {
    if (!partnerCompanyId) return;
    createMutation.mutate({
      data: {
        name,
        type,
        territory,
        owner_user_id: owner,
        partner_company_id: partnerCompanyId,
        activity_date: activityDate || null,
        notes: notes || null,
        opportunity_ids: opportunityIds,
      }
    });
  };

  const updateMutation = useUpdateCampaign({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        setEditDialogOpen(false);
        toast({ title: 'Activity updated' });
      },
      onError: errorToast('Could not update activity'),
    },
  });

  const deleteMutation = useDeleteCampaign({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        setDeleteDialogOpen(false);
        setActiveId(null);
        toast({ title: 'Activity deleted' });
      },
      onError: errorToast('Could not delete activity'),
    },
  });

  const openEditDialog = (id: string) => {
    const c = campaigns?.find(c => c.id === id);
    if (!c) return;
    setActiveId(id);
    setEditName(c.name);
    setEditType(c.type as CampaignType);
    setEditOwner(c.owner_user_id);
    setEditStatus(c.status);
    setEditPartnerCompanyId(c.partner_company_id ?? NONE_PARTNER);
    setEditActivityDate(c.activity_date ?? '');
    setEditHubspotLink(c.hubspot_link ?? '');
    setEditMqls(String(c.mqls ?? 0));
    setEditPartnerReferrals(String(c.partner_referrals ?? 0));
    setEditNotes(c.notes ?? '');
    setEditOpportunityIds(c.linked_opportunity_ids ?? []);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (!activeId) return;
    updateMutation.mutate({
      id: activeId,
      data: {
        name: editName,
        type: editType,
        owner_user_id: editOwner,
        status: editStatus,
        partner_company_id: editPartnerCompanyId === NONE_PARTNER ? null : editPartnerCompanyId,
        activity_date: editActivityDate || null,
        hubspot_link: editHubspotLink || null,
        mqls: Number(editMqls) || 0,
        partner_referrals: Number(editPartnerReferrals) || 0,
        notes: editNotes || null,
        opportunity_ids: editOpportunityIds,
      },
    });
  };

  const handleDelete = () => {
    if (!activeId) return;
    deleteMutation.mutate({ id: activeId });
  };

  return (
    <div className="flex flex-col h-full w-full bg-background relative">
      <div className="flex-none p-6 pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Marketing Activities</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Joint campaigns, events, webinars, and other partner activities — with optional links to real opportunities.
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New activity
        </Button>
      </div>

      <div className="flex-none px-6 pb-4 flex items-center gap-3">
        <Select value={filterPartner} onValueChange={setFilterPartner}>
          <SelectTrigger className="w-[190px]"><SelectValue placeholder="All partners" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All partners</SelectItem>
            {partners?.map(p => (
              <SelectItem key={p.company.id} value={p.company.id}>{p.company.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={(v) => setFilterType(v as CampaignType | typeof ALL)}>
          <SelectTrigger className="w-[220px]"><SelectValue placeholder="All types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {TYPE_OPTIONS.map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as 'planned' | 'live' | 'completed' | typeof ALL)}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            <SelectItem value="planned">Planned</SelectItem>
            <SelectItem value="live">Live</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 px-6 pb-6 overflow-auto">
        <div className="border border-border/60 rounded-md bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Partner</TableHead>
                <TableHead>Territory</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Commercial impact</TableHead>
                <TableHead className="text-right">Results (MQLs / Referrals)</TableHead>
                <TableHead className="w-[220px]">Notes</TableHead>
                <TableHead className="w-[40px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-5 w-[150px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[80px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[80px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[60px] ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[150px]" /></TableCell>
                    <TableCell />
                  </TableRow>
                ))
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-10 text-muted-foreground">
                    Could not load activities.{' '}
                    <button className="underline underline-offset-2 hover:text-foreground" onClick={() => refetch()}>
                      Try again
                    </button>
                  </TableCell>
                </TableRow>
              ) : campaigns?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-10 text-muted-foreground">
                    No activities yet.
                  </TableCell>
                </TableRow>
              ) : (
                campaigns?.map(campaign => (
                  <TableRow key={campaign.id}>
                    <TableCell className="font-medium">{campaign.name}</TableCell>
                    <TableCell><TypeBadge type={campaign.type} /></TableCell>
                    <TableCell className="text-muted-foreground">{campaign.partner_company_name ?? '—'}</TableCell>
                    <TableCell>{campaign.territory}</TableCell>
                    <TableCell className="text-muted-foreground">{campaign.activity_date ?? '—'}</TableCell>
                    <TableCell><StatusBadge status={campaign.status} /></TableCell>
                    <TableCell><CommercialImpactCell campaign={campaign} /></TableCell>
                    <TableCell className="text-right tabular-nums">{campaign.mqls} / {campaign.partner_referrals}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[220px] truncate">{campaign.notes}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(campaign.id)}>
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                          </DropdownMenuItem>
                          {campaign.hubspot_link && (
                            <DropdownMenuItem asChild>
                              <a href={campaign.hubspot_link} target="_blank" rel="noreferrer">
                                <ExternalLink className="h-3.5 w-3.5 mr-2" /> Open in HubSpot
                              </a>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => { setActiveId(campaign.id); setDeleteDialogOpen(true); }}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Edit activity</DialogTitle>
            <DialogDescription>Update details, status, or logged results.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4 max-h-[70vh] overflow-auto">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={editType} onValueChange={v => setEditType(v as CampaignType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TYPE_OPTIONS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={editStatus} onValueChange={v => setEditStatus(v as typeof editStatus)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="planned">Planned</SelectItem>
                    <SelectItem value="live">Live</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Owner</Label>
                <Select value={editOwner} onValueChange={setEditOwner} disabled={!isGlobalUser}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {isGlobalUser
                      ? users?.map(u => (
                          <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                        ))
                      : activeUser && (
                          <SelectItem key={activeUser.id} value={activeUser.id}>{activeUser.name}</SelectItem>
                        )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Date</Label>
                <Input type="date" value={editActivityDate} onChange={e => setEditActivityDate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Partner</Label>
              <Select
                value={editPartnerCompanyId}
                onValueChange={v => { setEditPartnerCompanyId(v); setEditOpportunityIds([]); }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_PARTNER}>No specific partner (territory-wide)</SelectItem>
                  {partners?.map(p => (
                    <SelectItem key={p.company.id} value={p.company.id}>{p.company.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Linked opportunities</Label>
              <OpportunityLinkPicker
                partnerCompanyId={editPartnerCompanyId}
                selectedIds={editOpportunityIds}
                onChange={setEditOpportunityIds}
              />
            </div>
            <div className="space-y-2">
              <Label>HubSpot link</Label>
              <Input value={editHubspotLink} onChange={e => setEditHubspotLink(e.target.value)} placeholder="https://app.hubspot.com/..." />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>MQLs</Label>
                <Input type="number" min="0" value={editMqls} onChange={e => setEditMqls(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Partner referrals</Label>
                <Input type="number" min="0" value={editPartnerReferrals} onChange={e => setEditPartnerReferrals(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} className="h-20 resize-none" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={updateMutation.isPending}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete {activeCampaign?.name}?</DialogTitle>
            <DialogDescription>
              This permanently removes the activity. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              <Trash2 className="w-4 h-4 mr-2" />
              Delete activity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>New activity</DialogTitle>
            <DialogDescription>
              Log a joint campaign, event, webinar, or other partner activity.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4 max-h-[70vh] overflow-auto">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DACH Partner Summit" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={type} onValueChange={v => setType(v as CampaignType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TYPE_OPTIONS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Territory</Label>
                <Select value={territory} onValueChange={setTerritory}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {territories?.map(t => (
                      <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Owner</Label>
                <Select value={owner} onValueChange={setOwner} disabled={!isGlobalUser}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {isGlobalUser
                      ? users?.map(u => (
                          <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                        ))
                      : activeUser && (
                          <SelectItem key={activeUser.id} value={activeUser.id}>{activeUser.name}</SelectItem>
                        )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Date</Label>
                <Input type="date" value={activityDate} onChange={e => setActivityDate(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Partner</Label>
              <Select
                value={partnerCompanyId}
                onValueChange={v => { setPartnerCompanyId(v); setOpportunityIds([]); }}
              >
                <SelectTrigger><SelectValue placeholder="Select a partner" /></SelectTrigger>
                <SelectContent>
                  {partners?.map(p => (
                    <SelectItem key={p.company.id} value={p.company.id}>{p.company.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Linked opportunities (optional)</Label>
              <OpportunityLinkPicker
                partnerCompanyId={partnerCompanyId}
                selectedIds={opportunityIds}
                onChange={setOpportunityIds}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Any context worth capturing"
                className="h-20 resize-none"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending || !name || !territory || !owner || !partnerCompanyId}>
              Create activity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
