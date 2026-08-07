import React, { useState } from 'react';
import { 
  useListCampaigns,
  useCreateCampaign,
  useUpdateCampaign,
  useDeleteCampaign,
  useListTerritories,
  useListUsers,
  useListPartners,
  getListCampaignsQueryKey,
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
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useUser } from '@/contexts/user-context';
import { Plus, Pencil, Trash2, MoreVertical, ExternalLink } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const TYPE_LABELS: Record<string, string> = {
  joint_campaign: 'Joint campaign',
  event: 'Event',
  webinar: 'Webinar',
};

function TypeBadge({ type }: { type: string }) {
  return <Badge variant="secondary" className="font-normal">{TYPE_LABELS[type] ?? type}</Badge>;
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

const NONE_PARTNER = 'none';

export default function Campaigns() {
  const { activeUser } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: campaigns, isLoading } = useListCampaigns();
  const { data: territories } = useListTerritories();
  const { data: users } = useListUsers();
  const { data: partners } = useListPartners();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Create form
  const [name, setName] = useState('');
  const [type, setType] = useState<'joint_campaign' | 'event' | 'webinar'>('joint_campaign');
  const [territory, setTerritory] = useState('');
  const [owner, setOwner] = useState(activeUser?.id || '');
  const [partnerCompanyId, setPartnerCompanyId] = useState(NONE_PARTNER);
  const [activityDate, setActivityDate] = useState('');
  const [notes, setNotes] = useState('');

  // Edit form
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<'joint_campaign' | 'event' | 'webinar'>('joint_campaign');
  const [editOwner, setEditOwner] = useState('');
  const [editStatus, setEditStatus] = useState<'planned' | 'live' | 'completed'>('planned');
  const [editPartnerCompanyId, setEditPartnerCompanyId] = useState(NONE_PARTNER);
  const [editActivityDate, setEditActivityDate] = useState('');
  const [editHubspotLink, setEditHubspotLink] = useState('');
  const [editMqls, setEditMqls] = useState('0');
  const [editPartnerReferrals, setEditPartnerReferrals] = useState('0');
  const [editNotes, setEditNotes] = useState('');

  const activeCampaign = campaigns?.find(c => c.id === activeId) ?? null;

  const resetCreateForm = () => {
    setName('');
    setType('joint_campaign');
    setTerritory('');
    setOwner(activeUser?.id || '');
    setPartnerCompanyId(NONE_PARTNER);
    setActivityDate('');
    setNotes('');
  };

  const createMutation = useCreateCampaign({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        setCreateDialogOpen(false);
        resetCreateForm();
        toast({ title: 'Activity created' });
      }
    }
  });

  const handleCreate = () => {
    createMutation.mutate({
      data: {
        name,
        type,
        territory,
        owner_user_id: owner,
        partner_company_id: partnerCompanyId === NONE_PARTNER ? null : partnerCompanyId,
        activity_date: activityDate || null,
        notes: notes || null,
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
    },
  });

  const openEditDialog = (id: string) => {
    const c = campaigns?.find(c => c.id === id);
    if (!c) return;
    setActiveId(id);
    setEditName(c.name);
    setEditType(c.type);
    setEditOwner(c.owner_user_id);
    setEditStatus(c.status);
    setEditPartnerCompanyId(c.partner_company_id ?? NONE_PARTNER);
    setEditActivityDate(c.activity_date ?? '');
    setEditHubspotLink(c.hubspot_link ?? '');
    setEditMqls(String(c.mqls ?? 0));
    setEditPartnerReferrals(String(c.partner_referrals ?? 0));
    setEditNotes(c.notes ?? '');
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
          <h1 className="text-2xl font-semibold tracking-tight">Activities</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Joint campaigns, events, and webinars run with or for partners.
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New activity
        </Button>
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
                <TableHead className="text-right">Results (MQLs / Referrals)</TableHead>
                <TableHead className="w-[250px]">Notes</TableHead>
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
                    <TableCell><Skeleton className="h-5 w-[60px] ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[150px]" /></TableCell>
                    <TableCell />
                  </TableRow>
                ))
              ) : campaigns?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
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
                    <TableCell className="text-right tabular-nums">{campaign.mqls} / {campaign.partner_referrals}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[250px] truncate">{campaign.notes}</TableCell>
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
                <Select value={editType} onValueChange={v => setEditType(v as typeof editType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="joint_campaign">Joint campaign</SelectItem>
                    <SelectItem value="event">Event</SelectItem>
                    <SelectItem value="webinar">Webinar</SelectItem>
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
                <Select value={editOwner} onValueChange={setEditOwner}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {users?.map(u => (
                      <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                    ))}
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
              <Select value={editPartnerCompanyId} onValueChange={setEditPartnerCompanyId}>
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
              Log a joint campaign, event, or webinar.
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
                <Select value={type} onValueChange={v => setType(v as typeof type)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="joint_campaign">Joint campaign</SelectItem>
                    <SelectItem value="event">Event</SelectItem>
                    <SelectItem value="webinar">Webinar</SelectItem>
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
                <Select value={owner} onValueChange={setOwner}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {users?.map(u => (
                      <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                    ))}
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
              <Select value={partnerCompanyId} onValueChange={setPartnerCompanyId}>
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
            <Button onClick={handleCreate} disabled={createMutation.isPending || !name || !territory || !owner}>
              Create activity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
