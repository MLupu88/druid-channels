import React, { useState } from 'react';
import {
  useGetPamCommercialWorkspace,
  useGetPamCommercialRelationshipDeals,
  getGetPamCommercialRelationshipDealsQueryKey,
  type PamCommercialDeal,
  type PamCommercialRelationship,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import { statusTone } from '@/lib/status-tone';
import {
  AWAITING_REVIEW_SECTION_TITLE,
  COMMERCIAL_UNKNOWN,
  CRM_OWNER_LABEL,
  DEALS_REQUEST_FAILED_TITLE,
  DEALS_STALE_TIME_MS,
  DEAL_STATE_TONE,
  DEAL_UNAVAILABLE_TITLE,
  NOT_LINKED_TITLE,
  PROVEN_ZERO_COPY,
  RELATIONSHIP_STATUS_LABELS,
  RELATIONSHIP_STATUS_TONE,
  UNCONFIRMED_MARKER,
  availabilityTitle,
  classifyDealSet,
  dealErrorLabel,
  dealStateLabel,
  formatCrmOwner,
  formatDealAmount,
  formatDealDate,
  formatDruidRecord,
  formatIdLabel,
  isRetryableAvailability,
  returnedDealsLabel,
  truncationNotice,
} from '@/lib/pam-commercial';

/**
 * PAM Commercial Workspace v1 (Slice C): the Commercial tab of PamWorkspace.
 * The relationship listing (GET /pam-commercial) is DB-only; HubSpot deals
 * are read lazily, one relationship at a time, only when the operator opens
 * that partner (RelationshipDealsPanel is mounted only while open).
 *
 * pamUserId is only passed for the Head/Admin drill-down (pams.tsx) -- the
 * server requires it for global callers and forces a PAM to their own
 * workspace otherwise (see routes/pam_commercial.ts).
 */
export function PamCommercialWorkspace({ pamUserId, pamName }: { pamUserId?: string; pamName?: string }) {
  const params = pamUserId ? { pam_user_id: pamUserId } : {};
  const { data, isLoading, isError } = useGetPamCommercialWorkspace(params);

  if (isLoading) {
    return (
      <Card className="shadow-none border-border/60">
        <CardContent className="p-5 space-y-3">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card className="shadow-none border-border/60">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Could not load the commercial workspace.</CardContent>
      </Card>
    );
  }

  const confirmed = data.confirmed_relationships;
  const awaiting = data.awaiting_review;
  const linkedCount = confirmed.filter((r) => r.hubspot_link_status === 'linked').length;
  const owner = pamName ? pamName : 'you';

  return (
    <div className="space-y-4">
      <Card className="shadow-none border-border/60" data-testid="commercial-confirmed-partners">
        <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20 space-y-1">
          <CardTitle className="text-base font-medium">Confirmed Portfolio partners</CardTitle>
          <p className="text-xs text-muted-foreground">
            {confirmed.length > 0
              ? `${confirmed.length} ${confirmed.length === 1 ? 'partner' : 'partners'} · ${linkedCount} linked to HubSpot. Open a linked partner to view current commercial activity.`
              : 'Active and dormant partners assigned to this PAM.'}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {confirmed.length === 0 ? (
            <p className="py-8 px-5 text-center text-sm text-muted-foreground" data-testid="commercial-empty-confirmed">
              No confirmed Portfolio partners are assigned to {owner} yet.
            </p>
          ) : (
            <>
              {linkedCount === 0 && (
                <p className="px-5 py-3 text-xs text-muted-foreground border-b border-border/50" data-testid="commercial-none-linked">
                  None of these partners are linked to HubSpot, so their commercial activity is unknown.
                </p>
              )}
              <ul className="divide-y divide-border/50">
                {confirmed.map((r) => (
                  <RelationshipRow key={r.relationship_id} relationship={r} unconfirmed={false} />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <AwaitingReviewSection relationships={awaiting} />
    </div>
  );
}

function AwaitingReviewSection({ relationships }: { relationships: PamCommercialRelationship[] }) {
  const [open, setOpen] = useState(false);

  if (relationships.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 px-5 py-3" data-testid="commercial-awaiting-review">
        <p className="text-sm font-medium text-muted-foreground">{AWAITING_REVIEW_SECTION_TITLE}</p>
        <p className="text-xs text-muted-foreground mt-0.5" data-testid="commercial-empty-awaiting-review">Nothing is awaiting review.</p>
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-dashed border-border/70 bg-muted/10" data-testid="commercial-awaiting-review">
      <CollapsibleTrigger asChild>
        <button type="button" className="w-full flex items-center gap-2 px-5 py-3 text-left" data-testid="button-toggle-awaiting-review">
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
          <span className="text-sm font-medium text-muted-foreground">{AWAITING_REVIEW_SECTION_TITLE}</span>
          <span className="text-xs text-muted-foreground">({relationships.length})</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="px-5 pb-3 text-xs text-muted-foreground">
          CRM or opportunity evidence suggests a relationship, but it has not been confirmed. HubSpot deals shown here do not make it a partner.
        </p>
        <ul className="divide-y divide-border/50 border-t border-dashed border-border/70">
          {relationships.map((r) => (
            <RelationshipRow key={r.relationship_id} relationship={r} unconfirmed />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RelationshipSummary({ relationship, unconfirmed }: { relationship: PamCommercialRelationship; unconfirmed: boolean }) {
  const linked = relationship.hubspot_link_status === 'linked';
  return (
    <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="min-w-0">
        <p className="text-sm font-medium break-words">{relationship.company_name}</p>
        <p className="text-xs text-muted-foreground break-words">
          {[relationship.company_domain, relationship.territory_name].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
        {unconfirmed && (
          <Badge variant="outline" className={`font-normal ${statusTone('warning')}`}>{UNCONFIRMED_MARKER}</Badge>
        )}
        <Badge variant="outline" className={`font-normal ${statusTone(RELATIONSHIP_STATUS_TONE[relationship.status] ?? 'neutral')}`}>
          {RELATIONSHIP_STATUS_LABELS[relationship.status] ?? relationship.status}
        </Badge>
        <Badge variant="outline" className={`font-normal ${linked ? statusTone('info') : 'text-muted-foreground'}`}>
          {linked ? 'HubSpot linked' : NOT_LINKED_TITLE}
        </Badge>
      </div>
    </div>
  );
}

function RelationshipRow({ relationship, unconfirmed }: { relationship: PamCommercialRelationship; unconfirmed: boolean }) {
  const [open, setOpen] = useState(false);

  // Not linked: HubSpot is never queried, so there is nothing to open --
  // commercial activity is unknown, never zero.
  if (relationship.hubspot_link_status !== 'linked') {
    return (
      <li className="px-5 py-3 flex items-start gap-2" data-testid={`commercial-relationship-${relationship.relationship_id}`}>
        <span className="w-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <RelationshipSummary relationship={relationship} unconfirmed={unconfirmed} />
          <p className="text-xs text-muted-foreground">{NOT_LINKED_TITLE} · {COMMERCIAL_UNKNOWN}</p>
        </div>
      </li>
    );
  }

  return (
    <li data-testid={`commercial-relationship-${relationship.relationship_id}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full px-5 py-3 flex items-start gap-2 text-left hover:bg-muted/30" aria-expanded={open}>
            <ChevronRight className={`h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
            <RelationshipSummary relationship={relationship} unconfirmed={unconfirmed} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {open && <RelationshipDealsPanel relationshipId={relationship.relationship_id} unconfirmed={unconfirmed} />}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function PanelNote({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}

// Mounted only while its relationship is open -- this is what keeps the
// HubSpot read lazy and per-partner.
function RelationshipDealsPanel({ relationshipId, unconfirmed }: { relationshipId: string; unconfirmed: boolean }) {
  const { data, isLoading, isError, isFetching, refetch } = useGetPamCommercialRelationshipDeals(relationshipId, {
    query: { queryKey: getGetPamCommercialRelationshipDealsQueryKey(relationshipId), staleTime: DEALS_STALE_TIME_MS },
  });

  const retry = (
    <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
      Retry
    </Button>
  );

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <div className="space-y-2" data-testid="commercial-deals-loading">
        <p className="text-xs text-muted-foreground">Loading HubSpot deals…</p>
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-3/4" />
      </div>
    );
  } else if (isError || !data) {
    body = <PanelNote title={DEALS_REQUEST_FAILED_TITLE} body={`${COMMERCIAL_UNKNOWN}.`} action={retry} />;
  } else {
    const view = classifyDealSet(data);
    if (view.kind === 'not_linked') {
      body = <PanelNote title={NOT_LINKED_TITLE} body={`${COMMERCIAL_UNKNOWN}.`} />;
    } else if (view.kind === 'unavailable') {
      body = (
        <PanelNote
          title={availabilityTitle(view.availability)}
          body={`${COMMERCIAL_UNKNOWN}.`}
          action={isRetryableAvailability(view.availability) ? retry : undefined}
        />
      );
    } else if (view.kind === 'proven_zero') {
      body = <p className="text-sm text-muted-foreground" data-testid="commercial-proven-zero">{PROVEN_ZERO_COPY}.</p>;
    } else {
      body = (
        <div className="space-y-2">
          {view.truncated ? (
            <p className="text-xs text-muted-foreground rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5" data-testid="commercial-deals-truncated">
              {truncationNotice(view.returnedCount)}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{returnedDealsLabel(view.returnedCount)} in HubSpot</p>
          )}
          {data.pipeline_metadata === 'unavailable' && (
            <p className="text-xs text-muted-foreground">Pipeline and stage labels are unavailable; raw HubSpot IDs are shown.</p>
          )}
          <ul className="divide-y divide-border/50 rounded-md border border-border/60 bg-background">
            {view.deals.map((deal) => (
              <DealRow key={deal.deal_id} deal={deal} />
            ))}
          </ul>
        </div>
      );
    }
  }

  return (
    <div className="px-5 pb-4 pl-11 space-y-2" data-testid={`commercial-deals-${relationshipId}`}>
      {unconfirmed && (
        <p className="text-xs text-muted-foreground">{UNCONFIRMED_MARKER} — awaiting review. HubSpot deals are shown for review only.</p>
      )}
      {body}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1 min-w-0">
      <dt className="shrink-0">{label}:</dt>
      <dd className="text-foreground/80 break-words min-w-0">{value}</dd>
    </div>
  );
}

function DealRow({ deal }: { deal: PamCommercialDeal }) {
  // A deal that could not be read stays visible -- it is still associated
  // with the company.
  if (deal.load_status === 'unavailable' || !deal.facts) {
    const reason = dealErrorLabel(deal.error);
    return (
      <li className="px-3 py-2.5" data-testid={`commercial-deal-${deal.deal_id}`}>
        <p className="text-sm font-medium text-muted-foreground">{DEAL_UNAVAILABLE_TITLE}</p>
        <p className="text-xs text-muted-foreground break-words">
          HubSpot deal ID {deal.deal_id}
          {reason ? ` · ${reason}` : ''}
        </p>
      </li>
    );
  }

  const f = deal.facts;
  const amount = formatDealAmount(f.amount, f.currency);
  const druidRecords = deal.druid_opportunities.match_status === 'matched' ? deal.druid_opportunities.records : [];

  return (
    <li className="px-3 py-2.5 space-y-1.5" data-testid={`commercial-deal-${deal.deal_id}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium break-words">{f.deal_name || 'Untitled deal'}</span>
          <Badge variant="outline" className={`font-normal ${statusTone(DEAL_STATE_TONE[f.deal_state] ?? 'neutral')}`}>
            {dealStateLabel(f.deal_state)}
          </Badge>
        </div>
        <span className={`text-sm tabular-nums ${amount ? 'font-medium' : 'text-muted-foreground'}`}>{amount ?? 'Amount not set'}</span>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Fact label="Pipeline" value={formatIdLabel(f.pipeline)} />
        <Fact label="Stage" value={formatIdLabel(f.stage)} />
        <Fact label={f.deal_state === 'open' ? 'Expected close' : 'Close date'} value={formatDealDate(f.close_date) ?? 'Not set'} />
        <Fact label={CRM_OWNER_LABEL} value={formatCrmOwner(f.crm_owner)} />
        <Fact label="Last modified" value={formatDealDate(f.last_modified_at) ?? '—'} />
        <Fact label="HubSpot ID" value={deal.deal_id} />
      </dl>
      {druidRecords.length > 0 && (
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          {druidRecords.map((record) => (
            <p key={record.opportunity_id} className="break-words">DRUID record: {formatDruidRecord(record)}</p>
          ))}
        </div>
      )}
    </li>
  );
}
