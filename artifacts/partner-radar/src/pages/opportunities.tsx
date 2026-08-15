import React, { useMemo, useState } from 'react';
import { useSearch, Link } from 'wouter';
import {
  useListOpportunities,
  getListOpportunitiesQueryKey,
  useCreateOpportunity,
  useUpdateOpportunity,
  useListTerritories,
  useSearchCompanies,
  getSearchCompaniesQueryKey,
} from '@workspace/api-client-react';
import type {
  Opportunity,
  OpportunityInput,
  OpportunityEditInput,
  OpportunityStatus,
  OpportunityAttributionType,
  ListOpportunitiesParams,
} from '@workspace/api-client-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Plus, ChevronDown, X, Upload, Inbox, AlertCircle } from 'lucide-react';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { formatMoney, type Currency } from '@/lib/kpi-format';
import { PageHeader } from '@/components/page-header';
import { statusTone } from '@/lib/status-tone';

const ATTRIBUTION_LABELS: Record<string, string> = {
  partner_sourced: 'Partner-Sourced',
  partner_influenced: 'Partner-Influenced',
};

const STATUS_LABELS: Record<string, string> = { open: 'Open', won: 'Won', lost: 'Lost' };

const CURRENCIES: Currency[] = ['USD', 'EUR', 'GBP'];

function AttributionBadge({ type }: { type: string }) {
  const styles = type === 'partner_sourced' ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-violet-50 text-violet-700 border-violet-200';
  return <Badge variant="outline" className={`font-normal ${styles}`}>{ATTRIBUTION_LABELS[type] ?? type}</Badge>;
}

function OppStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    open: statusTone('info'),
    won: statusTone('success'),
    lost: statusTone('neutral'),
  };
  return <Badge variant="outline" className={`font-normal ${styles[status] ?? ''}`}>{STATUS_LABELS[status] ?? status}</Badge>;
}

export default function Opportunities() {
  const { user: activeUser, isGlobalUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: territories } = useListTerritories();

  // Canonical territory, same source of truth as portfolio.tsx: whichever
  // territories row has owner_user_id === this PAM's id. Used to auto-scope
  // creation (no visible territory picker for a PAM) and to detect the
  // "PAM owns no territory yet" blocking state before ever calling
  // GET /opportunities (which would otherwise 403).
  const myTerritory = !isGlobalUser ? territories?.find((t) => t.owner_user_id === activeUser?.id) : undefined;
  const territoriesLoaded = !!territories;
  const pamHasNoTerritory = !isGlobalUser && territoriesLoaded && !myTerritory;

  // Head/Admin is view-only for Phase 5B-2 -- creating/editing on someone
  // else's behalf would need a PAM + territory picker the brief explicitly
  // asks to avoid this slice ("no complex reassignment UI", "Head
  // visibility is secondary to PAM execution"). A PAM always mutates only
  // their own records, so no per-row scope check is needed beyond this.
  const canMutate = !isGlobalUser;

  const [status, setStatus] = useState<'all' | OpportunityStatus>('all');
  const [attributionType, setAttributionType] = useState<'all' | OpportunityAttributionType>('all');
  const [territoryFilter, setTerritoryFilter] = useState<string>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Opportunity | null>(null);

  // Partner-context deep link from Portfolio's relationship detail drawer
  // (?company=<id>) -- a client-side filter only, since GET /opportunities
  // has no company_id query param and the scoped list is already small.
  const locationSearch = useSearch();
  const deepLinkCompanyId = new URLSearchParams(locationSearch).get('company');
  const [companyFilter, setCompanyFilter] = useState<string | null>(deepLinkCompanyId);

  const listParams: ListOpportunitiesParams = {
    ...(status !== 'all' ? { status } : {}),
    ...(attributionType !== 'all' ? { attribution_type: attributionType } : {}),
    ...(isGlobalUser && territoryFilter !== 'all' ? { territory: territoryFilter } : {}),
  };
  const { data: opportunities, isLoading, isError } = useListOpportunities(listParams, {
    query: { enabled: !pamHasNoTerritory, queryKey: getListOpportunitiesQueryKey(listParams) },
  });

  const rows = useMemo(() => {
    const list = opportunities ?? [];
    return companyFilter ? list.filter((o) => o.company_id === companyFilter) : list;
  }, [opportunities, companyFilter]);

  const companyFilterName = companyFilter ? rows[0]?.company_name ?? (opportunities ?? []).find((o) => o.company_id === companyFilter)?.company_name : null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListOpportunitiesQueryKey() });

  if (pamHasNoTerritory) {
    return (
      <div className="p-6">
        <Card className="shadow-none border-amber-200 bg-amber-50 max-w-lg">
          <CardContent className="p-5 space-y-1">
            <p className="font-medium text-amber-900">No territory assigned</p>
            <p className="text-sm text-amber-800">
              Your account has no canonical territory yet, so there are no opportunities to show. Contact an admin to have a territory assigned to you.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Opportunities"
        description={isGlobalUser ? 'Partner-sourced and partner-influenced deals across the team.' : 'Partner-sourced and partner-influenced deals you’re actively working.'}
        actions={
          <>
            {isGlobalUser && (
              <Link href="/opportunities/import">
                <Button size="sm" variant="outline" className="gap-1.5" data-testid="button-import-opportunities">
                  <Upload className="h-4 w-4" /> Import historical opportunities
                </Button>
              </Link>
            )}
            {canMutate && (
              <Button size="sm" className="gap-1.5" data-testid="button-add-opportunity" onClick={() => { setEditing(null); setFormOpen(true); }}>
                <Plus className="h-4 w-4" /> Add opportunity
              </Button>
            )}
          </>
        }
      />

      <div className="flex items-center gap-3 flex-wrap">
        <Select value={status} onValueChange={(v) => setStatus(v as 'all' | OpportunityStatus)}>
          <SelectTrigger className="w-[140px] h-8 bg-background border-border/60" data-testid="select-status-filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(STATUS_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={attributionType} onValueChange={(v) => setAttributionType(v as 'all' | OpportunityAttributionType)}>
          <SelectTrigger className="w-[180px] h-8 bg-background border-border/60" data-testid="select-attribution-filter">
            <SelectValue placeholder="Attribution" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All attribution</SelectItem>
            {Object.entries(ATTRIBUTION_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        {isGlobalUser && (
          <Select value={territoryFilter} onValueChange={setTerritoryFilter}>
            <SelectTrigger className="w-[180px] h-8 bg-background border-border/60" data-testid="select-territory-filter">
              <SelectValue placeholder="Territory" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All territories</SelectItem>
              {territories?.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {companyFilter && (
          <Badge variant="outline" className="font-normal gap-1.5 h-8 px-2.5">
            Filtered by {companyFilterName ?? 'partner'}
            <button type="button" onClick={() => setCompanyFilter(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
      </div>

      <Card className="shadow-none border-border/70">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Opportunity</TableHead>
                <TableHead>Partner</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Attribution</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Opportunity date</TableHead>
                <TableHead>Expected close</TableHead>
                <TableHead>Last updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={9}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={9} className="p-0">
                    <Empty className="border-none py-12">
                      <EmptyHeader>
                        <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
                        <EmptyTitle>Could not load opportunities</EmptyTitle>
                        <EmptyDescription>Please try again.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              ) : rows.length > 0 ? (
                rows.map((o) => (
                  <TableRow
                    key={o.id}
                    className={canMutate ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}
                    onClick={canMutate ? () => { setEditing(o); setFormOpen(true); } : undefined}
                  >
                    <TableCell className="font-medium">{o.name}</TableCell>
                    <TableCell className="text-muted-foreground">{o.company_name}</TableCell>
                    <TableCell className="text-muted-foreground">{o.customer_name || '—'}</TableCell>
                    <TableCell><AttributionBadge type={o.attribution_type} /></TableCell>
                    <TableCell><OppStatusBadge status={o.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(o.deal_value, o.currency)}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(o.opportunity_date).toLocaleDateString()}</TableCell>
                    <TableCell className="text-muted-foreground">{o.expected_close_date ? new Date(o.expected_close_date).toLocaleDateString() : '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(o.updated_at).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={9} className="p-0">
                    <Empty className="border-none py-12">
                      <EmptyHeader>
                        <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
                        {/* Kept as one literal string per role (not split into
                            a separate title) -- tests/opportunitiesUiScope.test.ts
                            asserts on the exact, contiguous copy. */}
                        <EmptyDescription>
                          {canMutate
                            ? "No opportunities yet. Add the partner-sourced or partner-influenced deals you're actively working."
                            : 'No opportunities yet. Partner-sourced and partner-influenced deals created by PAMs will appear here.'}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canMutate && formOpen && (
        <OpportunityFormDialog
          open={formOpen}
          opportunity={editing}
          territoryId={myTerritory?.id}
          assignedUserId={activeUser?.id}
          onOpenChange={setFormOpen}
          onSaved={() => { invalidate(); setFormOpen(false); toast({ title: editing ? 'Opportunity updated' : 'Opportunity created' }); }}
        />
      )}
    </div>
  );
}

function OpportunityFormDialog({
  open,
  opportunity,
  territoryId,
  assignedUserId,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  opportunity: Opportunity | null;
  territoryId: string | undefined;
  assignedUserId: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const isEdit = !!opportunity;

  const [companyId, setCompanyId] = useState(opportunity?.company_id ?? '');
  const [companyQuery, setCompanyQuery] = useState(opportunity?.company_name ?? '');
  const [name, setName] = useState(opportunity?.name ?? '');
  const [customerName, setCustomerName] = useState(opportunity?.customer_name ?? '');
  const [attributionType, setAttributionType] = useState(opportunity?.attribution_type ?? 'partner_sourced');
  const [dealValue, setDealValue] = useState(opportunity ? String(opportunity.deal_value) : '');
  const [currency, setCurrency] = useState<Currency>((opportunity?.currency as Currency) ?? 'USD');
  const [opportunityDate, setOpportunityDate] = useState(opportunity?.opportunity_date ?? new Date().toISOString().slice(0, 10));
  const [expectedCloseDate, setExpectedCloseDate] = useState(opportunity?.expected_close_date ?? '');
  const [status, setStatus] = useState(opportunity?.status ?? 'open');
  const [closedAt, setClosedAt] = useState(opportunity?.closed_at ? opportunity.closed_at.slice(0, 10) : '');
  const [note, setNote] = useState(opportunity?.note ?? '');
  const [creditOpen, setCreditOpen] = useState(!!(opportunity?.credit_value || opportunity?.credit_date));
  const [creditValue, setCreditValue] = useState(opportunity?.credit_value !== null && opportunity?.credit_value !== undefined ? String(opportunity.credit_value) : '');
  const [creditDate, setCreditDate] = useState(opportunity?.credit_date ?? '');

  const { data: companyResults } = useSearchCompanies(
    { q: companyQuery },
    // Disabled whenever a company is currently selected (companyId set) --
    // covers both the initial pre-filled edit state and any subsequent
    // selection, without excluding the case where a user clears the field
    // and retypes the original name.
    { query: { enabled: companyQuery.trim().length >= 2 && !companyId, queryKey: getSearchCompaniesQueryKey({ q: companyQuery }) } },
  );

  const createMutation = useCreateOpportunity({
    mutation: { onSuccess: onSaved, onError: (err: any) => toast({ variant: 'destructive', title: 'Could not create opportunity', description: err?.message ?? 'Please try again.' }) },
  });
  const updateMutation = useUpdateOpportunity({
    mutation: { onSuccess: onSaved, onError: (err: any) => toast({ variant: 'destructive', title: 'Could not save changes', description: err?.message ?? 'Please try again.' }) },
  });

  const dealValueNumber = Number(dealValue);
  const creditValueNumber = creditValue.trim() === '' ? null : Number(creditValue);
  const canSubmit =
    !!companyId &&
    name.trim().length > 0 &&
    !Number.isNaN(dealValueNumber) &&
    dealValueNumber > 0 &&
    !!opportunityDate &&
    (status !== 'won' || !!closedAt) &&
    (creditValueNumber === null || (!Number.isNaN(creditValueNumber) && creditValueNumber > 0));

  const handleSubmit = () => {
    if (!canSubmit) return;
    const shared = {
      company_id: companyId,
      name: name.trim(),
      customer_name: customerName.trim() || null,
      attribution_type: attributionType as any,
      deal_value: dealValueNumber,
      currency: currency as any,
      opportunity_date: opportunityDate,
      expected_close_date: expectedCloseDate || null,
      status: status as any,
      closed_at: status === 'won' ? closedAt : (closedAt || null),
      // credit_value and credit_date are independent overrides (see the
      // schema comment on partner_opportunities.creditDate) -- a PAM may
      // credit the deal's own value to a different target period by
      // setting only credit_date, so neither field may null out the other.
      credit_value: creditValueNumber,
      credit_date: creditDate || null,
      note: note.trim() || null,
    };

    if (isEdit && opportunity) {
      updateMutation.mutate({ id: opportunity.id, data: shared as OpportunityEditInput });
    } else {
      createMutation.mutate({
        data: { ...shared, territory_id: territoryId!, assigned_user_id: assignedUserId! } as OpportunityInput,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit opportunity' : 'Add opportunity'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="text-xs mb-1.5 block">Partner / company</Label>
            <Input
              value={companyQuery}
              onChange={(e) => { setCompanyQuery(e.target.value); setCompanyId(''); }}
              placeholder="Search companies..."
              data-testid="input-company"
            />
            {!companyId && companyResults && companyResults.length > 0 && (
              <div className="mt-1 border border-border/60 rounded-md divide-y max-h-[140px] overflow-auto">
                {companyResults.map((c) => (
                  <button key={c.id} type="button" className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted/50" onClick={() => { setCompanyId(c.id); setCompanyQuery(c.name); }}>
                    {c.name} <span className="text-muted-foreground">({c.domain ?? 'no domain'})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Opportunity name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Corp expansion" />
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Customer name (optional)</Label>
            <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="End customer, if different from the partner" />
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Attribution</Label>
            <Select value={attributionType} onValueChange={(v) => setAttributionType(v as OpportunityAttributionType)}>
              <SelectTrigger data-testid="select-attribution-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(ATTRIBUTION_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-[1fr_100px] gap-2">
            <div>
              <Label className="text-xs mb-1.5 block">Deal value</Label>
              <Input type="number" min="0" step="0.01" value={dealValue} onChange={(e) => setDealValue(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Currency</Label>
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs mb-1.5 block">Opportunity date</Label>
              <Input type="date" value={opportunityDate} onChange={(e) => setOpportunityDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Expected close (optional)</Label>
              <Input type="date" value={expectedCloseDate} onChange={(e) => setExpectedCloseDate(e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as OpportunityStatus)}>
              <SelectTrigger data-testid="select-opportunity-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(STATUS_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {status === 'won' && (
            <div>
              <Label className="text-xs mb-1.5 block">Closed date <span className="text-rose-600">(required for Won)</span></Label>
              <Input type="date" value={closedAt} onChange={(e) => setClosedAt(e.target.value)} data-testid="input-closed-at" />
            </div>
          )}

          <div>
            <Label className="text-xs mb-1.5 block">Notes (optional)</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="text-sm" />
          </div>

          <Collapsible open={creditOpen} onOpenChange={setCreditOpen}>
            <CollapsibleTrigger asChild>
              <button type="button" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground" data-testid="button-toggle-credit-override">
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${creditOpen ? 'rotate-180' : ''}`} />
                Target credit override
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 space-y-2">
              <p className="text-xs text-muted-foreground">Use only when commercial target credit differs from the deal's actual close value/date.</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs mb-1.5 block">Credit value (optional)</Label>
                  <Input type="number" min="0" step="0.01" value={creditValue} onChange={(e) => setCreditValue(e.target.value)} placeholder="Defaults to deal value" />
                </div>
                <div>
                  <Label className="text-xs mb-1.5 block">Credit date (optional)</Label>
                  <Input type="date" value={creditDate} onChange={(e) => setCreditDate(e.target.value)} />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || isPending} data-testid="button-submit-opportunity">
            {isEdit ? 'Save changes' : 'Create opportunity'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
