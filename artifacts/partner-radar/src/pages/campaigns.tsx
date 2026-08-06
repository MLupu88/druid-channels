import React, { useState } from 'react';
import { 
  useListCampaigns,
  useGetCampaign,
  useCreateCampaign,
  useListTerritories,
  useListUsers,
  getListCampaignsQueryKey,
  getGetCampaignQueryKey
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { useUser } from '@/contexts/user-context';
import { Plus, ChevronLeft, Calendar, Users, Target, MessageSquare } from 'lucide-react';
import { format } from 'date-fns';

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    planned: "bg-blue-50 text-blue-700 border-blue-200",
    active: "bg-emerald-50 text-emerald-700 border-emerald-200",
    completed: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={`font-normal ${styles[status] || ""}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

export default function Campaigns() {
  const { activeUser } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: campaigns, isLoading } = useListCampaigns();
  const { data: territories } = useListTerritories();
  const { data: users } = useListUsers();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // New Campaign Form
  const [name, setName] = useState('');
  const [territory, setTerritory] = useState('');
  const [owner, setOwner] = useState(activeUser?.id || '');
  const [segment, setSegment] = useState('');
  const [angle, setAngle] = useState('');

  const { data: detail, isLoading: isLoadingDetail } = useGetCampaign(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetCampaignQueryKey(selectedId || '') } }
  );

  const createMutation = useCreateCampaign({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        setCreateDialogOpen(false);
        // Reset form
        setName('');
        setTerritory('');
        setSegment('');
        setAngle('');
        toast({ title: 'Campaign created' });
      }
    }
  });

  const handleCreate = () => {
    createMutation.mutate({
      data: {
        name,
        territory,
        owner_user_id: owner,
        segment,
        message_angle: angle
      }
    });
  };

  if (selectedId) {
    return (
      <div className="flex flex-col h-full bg-background relative">
        <div className="flex-none p-4 border-b border-border/50 bg-card z-10 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => setSelectedId(null)}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{detail?.name || 'Loading...'}</h1>
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <span>{detail?.territory}</span>
                <span>•</span>
                <span>Owner: {detail?.owner_name}</span>
              </p>
            </div>
          </div>
          {detail && <StatusBadge status={detail.status} />}
        </div>
        
        <ScrollArea className="flex-1">
          <div className="p-6 max-w-6xl mx-auto space-y-8">
            {isLoadingDetail ? (
              <div className="space-y-4">
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : detail ? (
              <>
                <div className="grid grid-cols-4 gap-4">
                  <div className="bg-card border border-border/60 rounded-md p-4 flex items-start gap-4">
                    <Target className="h-8 w-8 text-primary opacity-80" />
                    <div>
                      <p className="text-sm text-muted-foreground">Segment</p>
                      <p className="font-medium mt-1">{detail.segment}</p>
                    </div>
                  </div>
                  <div className="bg-card border border-border/60 rounded-md p-4 flex items-start gap-4">
                    <MessageSquare className="h-8 w-8 text-primary opacity-80" />
                    <div>
                      <p className="text-sm text-muted-foreground">Message angle</p>
                      <p className="font-medium mt-1 truncate" title={detail.message_angle}>{detail.message_angle}</p>
                    </div>
                  </div>
                  <div className="bg-card border border-border/60 rounded-md p-4 flex items-start gap-4">
                    <Users className="h-8 w-8 text-primary opacity-80" />
                    <div>
                      <p className="text-sm text-muted-foreground">Prospects</p>
                      <p className="text-2xl font-semibold mt-1 tabular-nums">{detail.prospect_count}</p>
                    </div>
                  </div>
                  <div className="bg-card border border-border/60 rounded-md p-4 flex items-start gap-4">
                    <Calendar className="h-8 w-8 text-primary opacity-80" />
                    <div>
                      <p className="text-sm text-muted-foreground">Qualified meetings</p>
                      <p className="text-2xl font-semibold mt-1 tabular-nums">{detail.qualified_meetings || 0}</p>
                    </div>
                  </div>
                </div>

                <div className="border border-border/60 rounded-md bg-card overflow-hidden">
                  <div className="p-4 border-b border-border/50 bg-muted/20">
                    <h3 className="font-medium">Target Prospects</h3>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Company</TableHead>
                        <TableHead>Domain</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.prospects.map(p => (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{p.company.name}</TableCell>
                          <TableCell className="text-muted-foreground">{p.company.domain}</TableCell>
                          <TableCell>{p.partner_type}</TableCell>
                          <TableCell><StatusBadge status={p.status} /></TableCell>
                        </TableRow>
                      ))}
                      {detail.prospects.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                            No prospects added to this campaign yet.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-background relative">
      <div className="flex-none p-6 pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaign lists</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your targeted partner outreach campaigns.
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New campaign
        </Button>
      </div>

      <div className="flex-1 px-6 pb-6 overflow-auto">
        <div className="border border-border/60 rounded-md bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Territory</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Segment</TableHead>
                <TableHead className="text-right">Prospects</TableHead>
                <TableHead className="text-right">Meetings</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-5 w-[150px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[150px]" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[40px] ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[40px] ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-[80px]" /></TableCell>
                  </TableRow>
                ))
              ) : campaigns?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                    No campaigns found.
                  </TableCell>
                </TableRow>
              ) : (
                campaigns?.map(campaign => (
                  <TableRow 
                    key={campaign.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => setSelectedId(campaign.id)}
                  >
                    <TableCell className="font-medium">{campaign.name}</TableCell>
                    <TableCell>{campaign.territory}</TableCell>
                    <TableCell className="text-muted-foreground">{campaign.owner_name}</TableCell>
                    <TableCell className="text-muted-foreground max-w-[200px] truncate">{campaign.segment}</TableCell>
                    <TableCell className="text-right tabular-nums">{campaign.prospect_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{campaign.qualified_meetings || 0}</TableCell>
                    <TableCell><StatusBadge status={campaign.status} /></TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Create new campaign</DialogTitle>
            <DialogDescription>
              Set up a targeted list of prospects for outreach.
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Campaign Name</Label>
              <Input id="name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Q3 DACH Top Tier SI" />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Territory</Label>
                <Select value={territory} onValueChange={setTerritory}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {territories?.map(t => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Owner</Label>
                <Select value={owner} onValueChange={setOwner}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {users?.map(u => (
                      <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="segment">Target Segment</Label>
              <Input id="segment" value={segment} onChange={e => setSegment(e.target.value)} placeholder="e.g. System Integrators in Healthcare" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="angle">Message Angle</Label>
              <Textarea 
                id="angle" 
                value={angle} 
                onChange={e => setAngle(e.target.value)} 
                placeholder="What is the hook for this segment?"
                className="h-20 resize-none"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending || !name || !territory || !owner || !segment}>
              Create Campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}