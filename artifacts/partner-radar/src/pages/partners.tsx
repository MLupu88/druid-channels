import React, { useState } from 'react';
import {
  useListPartners,
  useGetPartner,
  useUpdatePartnerHelpNeeded,
  useListTerritories,
  getListPartnersQueryKey,
  getGetPartnerQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
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
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import {
  X,
  ExternalLink,
  Sparkles,
  Globe,
  Database,
  StickyNote,
  Sparkle,
  Lightbulb,
  Trophy,
  Award,
} from 'lucide-react';

const CATEGORY_META: Record<string, { label: string; icon: React.ElementType }> = {
  what_changed: { label: "What changed", icon: Lightbulb },
  whats_happening: { label: "What's happening", icon: Globe },
  customer_access: { label: "Customer access", icon: Trophy },
  ai_update: { label: "AI update", icon: Sparkle },
};

const SOURCE_KIND_META: Record<string, { label: string; icon: React.ElementType; className: string }> = {
  public_source: { label: 'Public source', icon: Globe, className: 'text-blue-700 bg-blue-50 border-blue-200' },
  ai_summary: { label: 'AI summary', icon: Sparkles, className: 'text-violet-700 bg-violet-50 border-violet-200' },
  hubspot_data: { label: 'HubSpot data', icon: Database, className: 'text-orange-700 bg-orange-50 border-orange-200' },
  pam_note: { label: 'PAM note', icon: StickyNote, className: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
};

const HELP_NEEDED_OPTIONS = [
  { value: 'none', label: 'No help needed' },
  { value: 'intro_to_customer', label: 'Intro to customer' },
  { value: 'pricing_support', label: 'Pricing support' },
  { value: 'legal_review', label: 'Legal review' },
  { value: 'exec_sponsorship', label: 'Exec sponsorship' },
  { value: 'other', label: 'Other' },
];

function SourceBadge({ sourceKind }: { sourceKind: string }) {
  const meta = SOURCE_KIND_META[sourceKind] ?? { label: sourceKind, icon: Globe, className: '' };
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={`font-normal gap-1 ${meta.className}`}>
      <Icon className="h-3 w-3" /> {meta.label}
    </Badge>
  );
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  return `$${value.toLocaleString()}`;
}

export default function Partners() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [territory, setTerritory] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [helpType, setHelpType] = useState('none');
  const [helpNote, setHelpNote] = useState('');

  const { data: territories } = useListTerritories();
  const { data: partners, isLoading } = useListPartners({
    ...(territory !== 'all' ? { territory } : {}),
  });

  const { data: detail, isLoading: isLoadingDetail } = useGetPartner(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetPartnerQueryKey(selectedId || '') } }
  );

  const openPartner = (id: string) => {
    setSelectedId(id);
  };

  React.useEffect(() => {
    if (detail) {
      setHelpType(detail.help_needed_type);
      setHelpNote(detail.help_needed_note || '');
    }
  }, [detail?.id]);

  const helpMutation = useUpdatePartnerHelpNeeded({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListPartnersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPartnerQueryKey(variables.id) });
        toast({ title: 'Help needed updated' });
      },
    },
  });

  const handleSaveHelp = () => {
    if (!selectedId) return;
    helpMutation.mutate({
      id: selectedId,
      data: {
        help_needed_type: helpType as any,
        help_needed_note: helpNote || null,
      },
    });
  };

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-none p-6 pb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Partners</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Research briefings on existing partners — what changed, what's happening, and where help is needed.
            </p>
          </div>
          <Select value={territory} onValueChange={setTerritory}>
            <SelectTrigger className="w-[180px] bg-card">
              <SelectValue placeholder="Territory" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All territories</SelectItem>
              {territories?.map(t => (
                <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 px-6 pb-6 overflow-auto">
          <div className="border border-border/60 rounded-md bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Company</TableHead>
                  <TableHead>Territory</TableHead>
                  <TableHead>PAM</TableHead>
                  <TableHead>Last researched</TableHead>
                  <TableHead>Open research items</TableHead>
                  <TableHead>Help needed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : partners?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                      No partners yet — accept a new partner prospect to see it here.
                    </TableCell>
                  </TableRow>
                ) : (
                  partners?.map(p => (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => openPartner(p.id)}
                    >
                      <TableCell className="font-medium">{p.company.name}</TableCell>
                      <TableCell className="text-muted-foreground">{p.territory_name}</TableCell>
                      <TableCell className="text-muted-foreground">{p.assigned_user?.name || '-'}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.last_researched_at ? new Date(p.last_researched_at).toLocaleDateString() : 'Never'}
                      </TableCell>
                      <TableCell className="tabular-nums">{p.open_research_count ?? 0}</TableCell>
                      <TableCell>
                        {p.help_needed_type === 'none' ? (
                          <span className="text-muted-foreground text-sm">—</span>
                        ) : (
                          <Badge variant="outline" className="font-normal text-amber-700 bg-amber-50 border-amber-200">
                            {HELP_NEEDED_OPTIONS.find(o => o.value === p.help_needed_type)?.label}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {/* Right Side Slide-over Panel */}
      {selectedId && (
        <div className="w-[480px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-muted/10">
            <h3 className="font-medium">{detail?.company.name || 'Loading...'}</h3>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setSelectedId(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {isLoadingDetail || !detail ? (
            <div className="p-5 space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="p-5 space-y-6">
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <a href={`https://${detail.company.domain}`} target="_blank" rel="noreferrer" className="hover:underline flex items-center gap-1">
                    {detail.company.domain} <ExternalLink className="h-3 w-3" />
                  </a>
                  <span>•</span>
                  <span>{detail.company.country}</span>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Commercial summary</h4>
                  <div className="rounded-md border border-border/60 overflow-hidden">
                    <div className="grid grid-cols-2 divide-x divide-border/60">
                      <div className="p-3">
                        <p className="text-xs text-muted-foreground">Pipeline sourced</p>
                        <p className="text-lg font-semibold tabular-nums mt-1">{formatCurrency(detail.commercial.pipeline_sourced)}</p>
                      </div>
                      <div className="p-3">
                        <p className="text-xs text-muted-foreground">Pipeline influenced</p>
                        <p className="text-lg font-semibold tabular-nums mt-1">{formatCurrency(detail.commercial.pipeline_influenced)}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 divide-x divide-border/60 border-t border-border/60">
                      <div className="p-3">
                        <p className="text-xs text-muted-foreground">Revenue closed</p>
                        <p className="text-lg font-semibold tabular-nums mt-1">{formatCurrency(detail.commercial.revenue_closed)}</p>
                      </div>
                      <div className="p-3">
                        <p className="text-xs text-muted-foreground">Renewal date</p>
                        <p className="text-sm font-medium mt-1">{detail.commercial.renewal_date || '—'}</p>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">Demo data — not connected to a live CRM.</p>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Help needed</h4>
                  <div className="space-y-2 rounded-md border border-border/60 p-3">
                    <Select value={helpType} onValueChange={setHelpType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {HELP_NEEDED_OPTIONS.map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Textarea
                      value={helpNote}
                      onChange={e => setHelpNote(e.target.value)}
                      placeholder="Add context for the Head of Channels..."
                      className="text-sm min-h-[70px]"
                    />
                    <Button size="sm" className="w-full" onClick={handleSaveHelp} disabled={helpMutation.isPending}>
                      Save
                    </Button>
                  </div>
                </div>

                {detail.research_items.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Research briefing</h4>
                    <div className="space-y-3">
                      {Object.entries(CATEGORY_META).map(([key, meta]) => {
                        const items = detail.research_items.filter(r => r.category === key);
                        if (items.length === 0) return null;
                        const Icon = meta.icon;
                        return (
                          <div key={key} className="space-y-2">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                              <Icon className="h-3.5 w-3.5" /> {meta.label}
                            </div>
                            {items.map(item => (
                              <div key={item.id} className="rounded-md border border-border/60 p-3 space-y-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <h5 className="text-sm font-medium">{item.title}</h5>
                                  {item.is_possible_customer_opening && (
                                    <Badge variant="outline" className="font-normal text-emerald-700 bg-emerald-50 border-emerald-200 text-[10px] shrink-0">
                                      Possible customer opening
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-sm text-foreground/80 leading-relaxed">{item.summary}</p>
                                <div className="flex items-center justify-between pt-1">
                                  <SourceBadge sourceKind={item.source_kind} />
                                  {item.source_url && (
                                    <a href={item.source_url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1">
                                      {item.source_domain} <ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {detail.rfps.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">RFPs & tenders</h4>
                    <div className="space-y-2">
                      {detail.rfps.map(rfp => (
                        <div key={rfp.id} className="rounded-md border border-border/60 p-3 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <h5 className="text-sm font-medium">{rfp.title}</h5>
                            <Badge variant="secondary" className="font-normal text-[10px]">{rfp.country}</Badge>
                          </div>
                          <p className="text-sm text-foreground/80 leading-relaxed">{rfp.why_relevant}</p>
                          <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                            <span>{rfp.deadline ? `Deadline: ${rfp.deadline}` : 'No deadline listed'}</span>
                            {rfp.source_url && (
                              <a href={rfp.source_url} target="_blank" rel="noreferrer" className="hover:text-primary flex items-center gap-1">
                                {rfp.source_domain} <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {detail.events.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Events</h4>
                    <div className="space-y-2">
                      {detail.events.map(event => (
                        <div key={event.id} className="rounded-md border border-border/60 p-3 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <h5 className="text-sm font-medium">{event.name}</h5>
                            <Badge variant="outline" className="font-normal text-[10px] gap-1 shrink-0">
                              <Award className="h-3 w-3" /> {event.suggested_action.replace(/_/g, ' ')}
                            </Badge>
                          </div>
                          <p className="text-sm text-foreground/80 leading-relaxed">{event.why_it_matters}</p>
                          <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                            <span>{[event.event_date, event.location].filter(Boolean).join(' • ') || 'Date/location TBD'}</span>
                            {event.source_url && (
                              <a href={event.source_url} target="_blank" rel="noreferrer" className="hover:text-primary flex items-center gap-1">
                                Source <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {detail.research_items.length === 0 && detail.rfps.length === 0 && detail.events.length === 0 && (
                  <p className="text-sm text-muted-foreground">No research recorded for this partner yet.</p>
                )}
              </div>
            </ScrollArea>
          )}
        </div>
      )}
    </div>
  );
}
