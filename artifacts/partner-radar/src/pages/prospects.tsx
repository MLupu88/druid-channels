import React, { useState, useRef, useEffect } from 'react';
import { 
  useListProspects, 
  useListTerritories, 
  useGetProspect, 
  useMakeProspectDecision,
  usePushProspectToHubspot,
  useRunScan,
  useListScanConfigs,
  useListUsers,
  useUpdateProspect,
  useDeleteProspect,
  getListProspectsQueryKey,
  getGetProspectQueryKey,
  getListUsersQueryKey
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import {
  Search,
  Filter,
  X,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Clock,
  MoreVertical,
  Check,
  Send,
  Minus,
  Pencil,
  Trash2
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format } from 'date-fns';
import { useAuth } from '@/contexts/auth-context';
import type { ProspectDecisionInputDecision } from '@workspace/api-client-react';

function generateRecruitmentMessage(detail: {
  company: { name: string };
  suggested_target_role?: string | null;
  suggested_angle?: string | null;
  why_now?: string | null;
}): string {
  const role = detail.suggested_target_role || 'the partnerships lead';
  const angle = detail.suggested_angle || 'building joint go-to-market motion together';
  const trigger = detail.why_now ? ` ${detail.why_now}` : '';
  return `Hi [Name],

I'm reaching out from DRUID because ${detail.company.name} looks like a strong fit for a partnership.${trigger}

I'd love to connect with ${role} to explore ${angle}. Would you be open to a short call in the next couple of weeks?

Best,
[Your name]`;
}

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'A') return <Badge className="bg-primary hover:bg-primary/90 text-primary-foreground border-transparent px-2 font-medium">A</Badge>;
  return <Badge variant="outline" className="text-muted-foreground px-2 font-medium">B</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    new: "bg-blue-50 text-blue-700 border-blue-200",
    accepted: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-muted text-muted-foreground border-border",
    deferred: "bg-amber-50 text-amber-700 border-amber-200",
    pushed_to_hubspot: "bg-orange-50 text-orange-700 border-orange-200",
  };
  return (
    <Badge variant="outline" className={`font-normal ${styles[status] || ""}`}>
      {status.replace(/_/g, ' ')}
    </Badge>
  );
}

export default function Prospects() {
  const { user: activeUser, isGlobalUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [territory, setTerritory] = useState<string>('all');
  const [priority, setPriority] = useState<string>('all');
  const [partnerType, setPartnerType] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Dialogs
  const [acceptDialogOpen, setAcceptDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [hubspotDialogOpen, setHubspotDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [note, setNote] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');

  const [editWhyItFits, setEditWhyItFits] = useState('');
  const [editWhyNow, setEditWhyNow] = useState('');
  const [editSuggestedMessage, setEditSuggestedMessage] = useState('');
  const [editPamNote, setEditPamNote] = useState('');
  const [editPriority, setEditPriority] = useState('A');
  const [editAssignedUserId, setEditAssignedUserId] = useState<string>('unassigned');
  const [draftMessage, setDraftMessage] = useState('');

  const { data: territories } = useListTerritories();
  const { data: users } = useListUsers({ query: { enabled: isGlobalUser, queryKey: getListUsersQueryKey() } });
  const { data: scanConfigs } = useListScanConfigs();
  
  const { data: prospects, isLoading } = useListProspects({
    ...(search ? { search } : {}),
    ...(territory !== 'all' ? { territory } : {}),
    ...(priority !== 'all' ? { priority } : {}),
    ...(partnerType !== 'all' ? { partner_type: partnerType } : {}),
    ...(status !== 'all' ? { status } : {}),
  });

  const { data: detail, isLoading: isLoadingDetail } = useGetProspect(
    selectedId || '', 
    { query: { enabled: !!selectedId, queryKey: getGetProspectQueryKey(selectedId || '') } }
  );

  useEffect(() => {
    setDraftMessage(detail?.suggested_message || '');
  }, [detail?.id]);

  const decisionMutation = useMakeProspectDecision({
    mutation: {
      onSuccess: (data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListProspectsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetProspectQueryKey(variables.id) });
        setAcceptDialogOpen(false);
        setRejectDialogOpen(false);
        setNote('');
        setRejectionReason('');
        toast({
          title: variables.data.decision === 'accepted' ? 'Prospect accepted' : `Prospect ${variables.data.decision}`,
          description: variables.data.decision === 'accepted' ? 'Ready to send to HubSpot.' : '',
        });
      }
    }
  });

  const hubspotMutation = usePushProspectToHubspot({
    mutation: {
      onSuccess: (data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListProspectsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetProspectQueryKey(variables.id) });
        setHubspotDialogOpen(false);
        if (data.status === 'success' || data.status === 'mock_success') {
          toast({
            title: `✓ Added to HubSpot`,
            description: `Company ID ${data.hubspot_company_id}`,
          });
        }
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Failed to push to HubSpot",
          description: "An error occurred during the integration sync."
        });
        setHubspotDialogOpen(false);
      }
    }
  });

  const updateMutation = useUpdateProspect({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListProspectsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetProspectQueryKey(variables.id) });
        setEditDialogOpen(false);
        toast({ title: 'Prospect updated' });
      },
    },
  });

  const deleteMutation = useDeleteProspect({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProspectsQueryKey() });
        setDeleteDialogOpen(false);
        setSelectedId(null);
        toast({ title: 'Prospect deleted' });
      },
    },
  });

  const openEditDialog = () => {
    if (!detail) return;
    setEditWhyItFits(detail.why_it_fits || '');
    setEditWhyNow(detail.why_now || '');
    setEditSuggestedMessage(detail.suggested_message || '');
    setEditPamNote(detail.pam_note || '');
    setEditPriority(detail.priority);
    setEditAssignedUserId(detail.assigned_user?.id || 'unassigned');
    setEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (!selectedId) return;
    updateMutation.mutate({
      id: selectedId,
      data: {
        why_it_fits: editWhyItFits,
        why_now: editWhyNow,
        suggested_message: editSuggestedMessage,
        pam_note: editPamNote,
        priority: editPriority as any,
        assigned_user_id: editAssignedUserId === 'unassigned' ? null : editAssignedUserId,
      },
    });
  };

  const handleDelete = () => {
    if (!selectedId) return;
    deleteMutation.mutate({ id: selectedId });
  };

  const runScanMutation = useRunScan({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProspectsQueryKey() });
        toast({
          title: "Mock scan complete",
          description: "New prospects discovered."
        });
      }
    }
  });

  const handleDecision = (decision: ProspectDecisionInputDecision) => {
    if (!selectedId) return;
    decisionMutation.mutate({
      id: selectedId,
      data: {
        decision,
        note: note || undefined,
        rejection_reason: rejectionReason || undefined,
        assigned_user_id: activeUser?.id
      }
    });
  };

  const handlePushToHubspot = () => {
    if (!selectedId) return;
    hubspotMutation.mutate({ id: selectedId });
  };

  const runMockScan = () => {
    const configId = scanConfigs?.[0]?.id;
    if (!configId) return;
    runScanMutation.mutate({
      data: {
        scan_config_id: configId,
        mode: 'mock',
      }
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ description: "Copied to clipboard" });
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden relative">
      <div className="flex-none p-4 border-b border-border/50 bg-card z-10 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">New partners</h1>
          <Button onClick={runMockScan} disabled={runScanMutation.isPending} variant="outline" size="sm" className="h-8">
            <Filter className="h-4 w-4 mr-2" />
            Run mock scan
          </Button>
        </div>
        
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-[250px]">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search companies..." 
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-8 bg-background border-border/60"
            />
          </div>
          
          <Select value={territory} onValueChange={setTerritory}>
            <SelectTrigger className="w-[140px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Territory" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Territories</SelectItem>
              {territories?.map(t => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger className="w-[110px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priorities</SelectItem>
              <SelectItem value="A">Priority A</SelectItem>
              <SelectItem value="B">Priority B</SelectItem>
            </SelectContent>
          </Select>

          <Select value={partnerType} onValueChange={setPartnerType}>
            <SelectTrigger className="w-[140px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Partner Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="SI">System Integrator</SelectItem>
              <SelectItem value="VAR">Value Added Reseller</SelectItem>
              <SelectItem value="ISV">ISV</SelectItem>
              <SelectItem value="Consulting">Consulting</SelectItem>
            </SelectContent>
          </Select>

          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[130px] h-8 bg-background border-border/60">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="accepted">Accepted</SelectItem>
              <SelectItem value="pushed_to_hubspot">In HubSpot</SelectItem>
              <SelectItem value="deferred">Deferred</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-auto relative bg-background">
        <Table>
          <TableHeader className="bg-card sticky top-0 z-10 shadow-sm shadow-border/20">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[200px]">Company</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead className="w-[300px]">Why now</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Territory</TableHead>
              <TableHead>PAM</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-[150px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[250px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[80px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[40px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[80px]" /></TableCell>
                </TableRow>
              ))
            ) : prospects?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                  No prospects found matching your filters.
                </TableCell>
              </TableRow>
            ) : (
              prospects?.map(prospect => (
                <TableRow 
                  key={prospect.id} 
                  className={`cursor-pointer hover:bg-muted/30 transition-colors ${selectedId === prospect.id ? 'bg-muted/50' : ''}`}
                  onClick={() => setSelectedId(prospect.id)}
                >
                  <TableCell className="font-medium">{prospect.company.name}</TableCell>
                  <TableCell className="text-muted-foreground">{prospect.company.domain}</TableCell>
                  <TableCell className="text-sm truncate max-w-[300px] text-muted-foreground">{prospect.why_now}</TableCell>
                  <TableCell className="text-sm">{prospect.partner_type}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{prospect.territory_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{prospect.assigned_user?.name || '-'}</TableCell>
                  <TableCell><PriorityBadge priority={prospect.priority} /></TableCell>
                  <TableCell><StatusBadge status={prospect.status} /></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Right Drawer */}
      <div 
        className={`absolute top-0 right-0 h-full w-[480px] bg-card border-l border-border/60 shadow-2xl transition-transform duration-300 ease-in-out flex flex-col z-50 ${selectedId ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {selectedId && detail && !isLoadingDetail ? (
          <>
            <div className="flex-none p-5 border-b border-border/50 bg-card">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-xl font-semibold">{detail.company.name}</h2>
                    <Badge variant="secondary" className="font-normal text-xs">{detail.partner_type}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <a href={`https://${detail.company.domain}`} target="_blank" rel="noreferrer" className="hover:underline flex items-center gap-1">
                      {detail.company.domain} <ExternalLink className="h-3 w-3" />
                    </a>
                    <span>•</span>
                    <span>{detail.company.country}</span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted" onClick={() => setSelectedId(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex items-center gap-3 mb-6">
                <PriorityBadge priority={detail.priority} />
                <StatusBadge status={detail.status} />
              </div>

              <div className="flex items-center gap-2">
                {detail.status === 'new' && (
                  <Button className="flex-1" onClick={() => setAcceptDialogOpen(true)}>
                    Accept prospect
                  </Button>
                )}
                {detail.status === 'accepted' && (
                  <Button className="flex-1 bg-[#ff7a59] hover:bg-[#e0694b] text-white" onClick={() => setHubspotDialogOpen(true)}>
                    Send to HubSpot
                  </Button>
                )}
                {detail.status === 'pushed_to_hubspot' && (
                  <Button className="flex-1 bg-white border border-border text-foreground hover:bg-muted" asChild>
                    <a href={`https://app.hubspot.com/contacts/mock/company/${detail.hubspot_company_id}`} target="_blank" rel="noreferrer">
                      Open in HubSpot <ExternalLink className="h-4 w-4 ml-2 text-muted-foreground" />
                    </a>
                  </Button>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="shrink-0 border-border/60">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={openEditDialog}>
                      <Pencil className="h-3.5 w-3.5 mr-2" /> Edit details
                    </DropdownMenuItem>
                    {(detail.status === 'new' || detail.status === 'deferred') && (
                      <>
                        <DropdownMenuItem onClick={() => handleDecision('deferred')}>
                          Defer for later
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setRejectDialogOpen(true)}>
                          Reject
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuItem onClick={() => copyToClipboard(window.location.href)}>
                      Copy link
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteDialogOpen(true)}>
                      <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete prospect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <ScrollArea className="flex-1 bg-background/50">
              <Tabs defaultValue="summary" className="w-full">
                <TabsList className="w-full justify-start rounded-none border-b border-border/50 bg-card h-12 p-0 px-2 gap-4">
                  <TabsTrigger value="summary" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-12">Summary</TabsTrigger>
                  <TabsTrigger value="evidence" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-12">Evidence <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[10px] h-4">{detail.signals.length}</Badge></TabsTrigger>
                  <TabsTrigger value="outreach" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-12">Outreach</TabsTrigger>
                  <TabsTrigger value="activity" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-12">Activity</TabsTrigger>
                </TabsList>
                
                <div className="p-5">
                  <TabsContent value="summary" className="m-0 space-y-6">
                    <div>
                      <h4 className="text-sm font-medium mb-2">Why it fits</h4>
                      <p className="text-sm text-foreground/80 leading-relaxed">{detail.why_it_fits}</p>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium mb-2">Why now</h4>
                      <p className="text-sm text-foreground/80 leading-relaxed">{detail.why_now}</p>
                    </div>
                    
                    <div className="bg-card border border-border/60 rounded-md p-4 space-y-3">
                      <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-2">Qualification checklist</h4>
                      
                      <div className="flex items-center gap-3">
                        {detail.enterprise_access ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Minus className="h-4 w-4 text-muted-foreground" />}
                        <span className={`text-sm ${detail.enterprise_access ? 'text-foreground' : 'text-muted-foreground'}`}>Enterprise customer access</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {detail.relevant_capability ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Minus className="h-4 w-4 text-muted-foreground" />}
                        <span className={`text-sm ${detail.relevant_capability ? 'text-foreground' : 'text-muted-foreground'}`}>Relevant capability</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {detail.technology_adjacency ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Minus className="h-4 w-4 text-muted-foreground" />}
                        <span className={`text-sm ${detail.technology_adjacency ? 'text-foreground' : 'text-muted-foreground'}`}>Technology adjacency</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {detail.partnership_openness ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Minus className="h-4 w-4 text-muted-foreground" />}
                        <span className={`text-sm ${detail.partnership_openness ? 'text-foreground' : 'text-muted-foreground'}`}>Partnership openness</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {detail.recent_trigger ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Minus className="h-4 w-4 text-muted-foreground" />}
                        <span className={`text-sm ${detail.recent_trigger ? 'text-foreground' : 'text-muted-foreground'}`}>Recent trigger</span>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="evidence" className="m-0 space-y-4">
                    {detail.signals.map(signal => (
                      <div key={signal.id} className="bg-card border border-border/60 rounded-md p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <Badge variant="secondary" className="font-normal capitalize">{signal.signal_type.replace(/_/g, ' ')}</Badge>
                          {signal.confidence === 'high' && <Badge variant="outline" className="border-emerald-200 text-emerald-700 bg-emerald-50 text-[10px] font-normal h-5">High match</Badge>}
                        </div>
                        <h4 className="font-medium text-sm">{signal.title}</h4>
                        
                        <div className="space-y-3">
                          <div className="relative">
                            <span className="absolute -top-2 left-2 bg-card px-1 text-[10px] text-muted-foreground font-medium tracking-wide">AI SUMMARY</span>
                            <p className="text-sm text-foreground/80 leading-relaxed border border-border/60 rounded-md p-3 pt-4 bg-muted/10">
                              {signal.summary}
                            </p>
                          </div>
                          
                          {signal.raw_excerpt && (
                            <blockquote className="border-l-2 border-primary/40 pl-3 py-1 my-2 text-sm text-muted-foreground italic bg-muted/20">
                              "{signal.raw_excerpt}"
                            </blockquote>
                          )}
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-border/50 text-xs text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <span>{signal.source_domain}</span>
                            {signal.published_at && <span>• {new Date(signal.published_at).toLocaleDateString()}</span>}
                          </div>
                          <a href={signal.source_url} target="_blank" rel="noreferrer" className="hover:text-primary flex items-center gap-1">
                            Source <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </TabsContent>

                  <TabsContent value="outreach" className="m-0 space-y-5">
                    <div>
                      <h4 className="text-sm font-medium mb-1">Suggested target role</h4>
                      <p className="text-sm text-muted-foreground">{detail.suggested_target_role}</p>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium mb-1">Opening angle</h4>
                      <p className="text-sm text-foreground/80 leading-relaxed">{detail.suggested_angle}</p>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium">Draft message</h4>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setDraftMessage(generateRecruitmentMessage(detail))}
                          >
                            Generate message
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => copyToClipboard(draftMessage)}>
                            Copy message
                          </Button>
                        </div>
                      </div>
                      <Textarea
                        value={draftMessage}
                        onChange={e => setDraftMessage(e.target.value)}
                        className="min-h-[250px] font-sans text-sm resize-y"
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="activity" className="m-0">
                    <div className="space-y-6 relative before:absolute before:inset-0 before:ml-[11px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent">
                      {detail.activity.map((item, idx) => (
                        <div key={item.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                          <div className="flex items-center justify-center w-6 h-6 rounded-full border border-border bg-card text-muted-foreground shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10">
                            <Clock className="h-3 w-3" />
                          </div>
                          <div className="w-[calc(100%-2.5rem)] md:w-[calc(50%-1.5rem)] p-3 rounded border border-border/60 bg-card shadow-sm">
                            <div className="flex items-center justify-between mb-1">
                              <h4 className="font-medium text-sm capitalize">{item.event_type.replace(/_/g, ' ')}</h4>
                              <time className="text-xs text-muted-foreground">{format(new Date(item.timestamp), 'MMM d, HH:mm')}</time>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {item.actor_name ? `by ${item.actor_name}` : 'System'}
                            </div>
                            {item.note && (
                              <div className="mt-2 text-sm text-foreground/80 bg-muted/20 p-2 rounded border border-border/40">
                                {item.note}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                </div>
              </Tabs>
            </ScrollArea>
          </>
        ) : selectedId && isLoadingDetail ? (
          <div className="p-6 space-y-6">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <div className="flex gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-[400px] w-full mt-8" />
          </div>
        ) : null}
      </div>

      {/* Dialogs */}
      <Dialog open={acceptDialogOpen} onOpenChange={setAcceptDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Accept {detail?.company.name}?</DialogTitle>
            <DialogDescription>
              This prospect will be assigned to you in the {detail?.territory_name} territory.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium mb-2 block">Add a note (optional)</label>
            <Textarea 
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Why are you accepting this?"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAcceptDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => handleDecision('accepted')} disabled={decisionMutation.isPending}>
              Accept prospect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Reject {detail?.company.name}</DialogTitle>
            <DialogDescription>
              Remove this prospect from the active pipeline.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Reason</label>
              <Select value={rejectionReason} onValueChange={setRejectionReason}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Too small">Too small</SelectItem>
                  <SelectItem value="No enterprise evidence">No enterprise evidence</SelectItem>
                  <SelectItem value="Capability not relevant">Capability not relevant</SelectItem>
                  <SelectItem value="No real partnership route">No real partnership route</SelectItem>
                  <SelectItem value="Duplicate">Duplicate</SelectItem>
                  <SelectItem value="Existing relationship">Existing relationship</SelectItem>
                  <SelectItem value="Wrong territory">Wrong territory</SelectItem>
                  <SelectItem value="Weak or outdated evidence">Weak or outdated evidence</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Note (optional)</label>
              <Textarea 
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Additional context"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => handleDecision('rejected')} disabled={decisionMutation.isPending || !rejectionReason}>
              Reject prospect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Edit {detail?.company.name}</DialogTitle>
            <DialogDescription>Update the qualification notes and outreach details for this prospect.</DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            <div>
              <label className="text-sm font-medium mb-2 block">Why it fits</label>
              <Textarea value={editWhyItFits} onChange={e => setEditWhyItFits(e.target.value)} className="min-h-[70px]" />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Why now</label>
              <Textarea value={editWhyNow} onChange={e => setEditWhyNow(e.target.value)} className="min-h-[70px]" />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Suggested message</label>
              <Textarea value={editSuggestedMessage} onChange={e => setEditSuggestedMessage(e.target.value)} className="min-h-[100px]" />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">PAM note</label>
              <Textarea value={editPamNote} onChange={e => setEditPamNote(e.target.value)} className="min-h-[60px]" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Priority</label>
                <Select value={editPriority} onValueChange={setEditPriority}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">Priority A</SelectItem>
                    <SelectItem value="B">Priority B</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Assigned PAM</label>
                <Select value={editAssignedUserId} onValueChange={setEditAssignedUserId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
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
            <DialogTitle>Delete {detail?.company.name}?</DialogTitle>
            <DialogDescription>
              This permanently removes the prospect and its activity history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              <Trash2 className="w-4 h-4 mr-2" />
              Delete prospect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={hubspotDialogOpen} onOpenChange={setHubspotDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Send to HubSpot</DialogTitle>
            <DialogDescription>
              This will create a new Company record in HubSpot.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2 text-sm text-foreground/80">
            <p><strong>Company:</strong> {detail?.company.name}</p>
            <p><strong>Domain:</strong> {detail?.company.domain}</p>
            <p><strong>Owner:</strong> {activeUser?.name}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHubspotDialogOpen(false)}>Cancel</Button>
            <Button onClick={handlePushToHubspot} disabled={hubspotMutation.isPending} className="bg-[#ff7a59] hover:bg-[#e0694b] text-white">
              <Send className="w-4 h-4 mr-2" />
              Confirm sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}