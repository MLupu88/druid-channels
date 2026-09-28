// PAM Commercial Workspace v1 (Slice C): pure presentation helpers for the
// Commercial tab (components/pam-commercial-workspace.tsx). Every decision
// here only renders what GET /pam-commercial and
// GET /pam-commercial/relationships/{id}/deals already established -- no
// state is re-derived, no deal is reinterpreted, and "unknown" is never
// collapsed into zero. Kept framework-free so the semantics are unit-testable
// without a React rendering harness (see tests/pamCommercialWorkspace.test.ts).
import type {
  PamCommercialCrmOwner,
  PamCommercialDealError,
  PamCommercialDealFactsDealState,
  PamCommercialDruidOpportunity,
  PamCommercialHubSpotStatusAvailability,
  PamCommercialIdLabel,
  PamCommercialRelationshipDeals,
  PamCommercialDeal,
} from '@workspace/api-client-react';
import type { StatusTone } from './status-tone';

// Each open partner triggers a live HubSpot read server-side (no server
// cache), so a re-open within this window reuses the React Query cache.
export const DEALS_STALE_TIME_MS = 5 * 60 * 1000;

// ---- Relationship --------------------------------------------------------

export const RELATIONSHIP_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  dormant: 'Dormant',
  needs_review: 'Needs review',
};

export const RELATIONSHIP_STATUS_TONE: Record<string, StatusTone> = {
  active: 'success',
  dormant: 'warning',
  needs_review: 'info',
};

export const AWAITING_REVIEW_SECTION_TITLE = 'Awaiting review — not confirmed partners';
export const UNCONFIRMED_MARKER = 'Not a confirmed partner';

export const NOT_LINKED_TITLE = 'HubSpot not linked';
export const COMMERCIAL_UNKNOWN = 'Commercial activity unknown';

// ---- Deal set ------------------------------------------------------------

export type DealSetView =
  | { kind: 'not_linked' }
  | { kind: 'unavailable'; availability: PamCommercialHubSpotStatusAvailability }
  | { kind: 'proven_zero' }
  | { kind: 'deals'; deals: PamCommercialDeal[]; returnedCount: number; truncated: boolean };

// Only availability=available with an actual array is a known deal set; only
// a known, empty, non-truncated set is a real zero.
export function classifyDealSet(response: Pick<PamCommercialRelationshipDeals, 'hubspot' | 'association' | 'deals'>): DealSetView {
  const { availability } = response.hubspot;
  if (availability === 'not_linked') return { kind: 'not_linked' };
  if (availability !== 'available' || !Array.isArray(response.deals)) return { kind: 'unavailable', availability };
  const truncated = response.association?.truncated ?? false;
  if (response.deals.length === 0 && !truncated) return { kind: 'proven_zero' };
  return { kind: 'deals', deals: response.deals, returnedCount: response.association?.returned_count ?? response.deals.length, truncated };
}

export const PROVEN_ZERO_COPY = 'No deals currently associated with this HubSpot company';

const AVAILABILITY_TITLES: Record<PamCommercialHubSpotStatusAvailability, string> = {
  not_linked: NOT_LINKED_TITLE,
  available: 'HubSpot data incomplete',
  not_configured: 'HubSpot not configured',
  credential_error: 'HubSpot credential unavailable',
  authentication_failed: 'HubSpot authentication failed',
  permission_denied: 'HubSpot access denied',
  rate_limited: 'HubSpot rate limit reached',
  timeout: 'HubSpot timed out',
  provider_error: 'HubSpot could not be read',
  hubspot_company_not_found: 'Linked HubSpot company not found',
  invalid_hubspot_company_id: 'Stored HubSpot company ID is invalid',
};

const RETRYABLE_AVAILABILITY = new Set<PamCommercialHubSpotStatusAvailability>(['rate_limited', 'timeout', 'provider_error']);

export function availabilityTitle(availability: PamCommercialHubSpotStatusAvailability): string {
  return AVAILABILITY_TITLES[availability] ?? 'HubSpot unavailable';
}

export function isRetryableAvailability(availability: PamCommercialHubSpotStatusAvailability): boolean {
  return RETRYABLE_AVAILABILITY.has(availability);
}

// Request-level failure (403/404/409/network) -- the deal set is unknown.
export const DEALS_REQUEST_FAILED_TITLE = 'Could not load HubSpot deals';

export function truncationNotice(returnedCount: number): string {
  return `Showing ${returnedCount} associated ${returnedCount === 1 ? 'deal' : 'deals'}. More may exist in HubSpot.`;
}

export function returnedDealsLabel(returnedCount: number): string {
  return `${returnedCount} associated ${returnedCount === 1 ? 'deal' : 'deals'}`;
}

// ---- Deal facts ----------------------------------------------------------

export const DEAL_STATE_LABELS: Record<PamCommercialDealFactsDealState, string> = {
  open: 'Open',
  closed_won: 'Closed won',
  closed_lost: 'Closed lost',
  closed_outcome_unknown: 'Closed — outcome unknown',
  unknown: 'State unknown',
};

export const DEAL_STATE_TONE: Record<PamCommercialDealFactsDealState, StatusTone> = {
  open: 'info',
  closed_won: 'success',
  closed_lost: 'danger',
  closed_outcome_unknown: 'neutral',
  unknown: 'neutral',
};

export function dealStateLabel(state: PamCommercialDealFactsDealState): string {
  return DEAL_STATE_LABELS[state] ?? DEAL_STATE_LABELS.unknown;
}

export const DEAL_UNAVAILABLE_TITLE = 'Deal details unavailable';

const DEAL_ERROR_LABELS: Record<NonNullable<PamCommercialDealError>, string> = {
  authentication_failed: 'HubSpot authentication failed',
  permission_denied: 'HubSpot denied access',
  rate_limited: 'HubSpot rate limit reached',
  timeout: 'HubSpot timed out',
  not_found: 'Not found in HubSpot',
  provider_error: 'HubSpot could not be read',
  invalid_deal_id: 'Invalid HubSpot deal ID',
};

export function dealErrorLabel(error: PamCommercialDealError): string | null {
  return error ? DEAL_ERROR_LABELS[error] ?? null : null;
}

// HubSpot amounts arrive as raw strings. Formats only when the value is a
// plain finite number; otherwise the raw value is shown untouched.
export function formatDealAmount(amount: string | null, currency: string | null): string | null {
  if (amount === null || amount.trim() === '') return null;
  const value = Number(amount);
  if (!Number.isFinite(value)) return currency ? `${amount} ${currency}` : amount;
  const code = currency?.trim().toUpperCase() || null;
  if (code) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(value);
    } catch {
      return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} ${code}`;
    }
  }
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} (currency not set)`;
}

// Pipeline/stage: the raw HubSpot ID is always preserved when the label
// could not be resolved.
export function formatIdLabel(value: PamCommercialIdLabel): string {
  if (value.label) return value.label;
  if (value.id) return `${value.id} (label unavailable)`;
  return 'Not set';
}

export const CRM_OWNER_LABEL = 'CRM owner';
export const OWNER_DETAILS_UNAVAILABLE = 'Owner details unavailable';

// HubSpot CRM owner of the deal -- never the PAM. Never invents a person.
export function formatCrmOwner(owner: PamCommercialCrmOwner | null): string {
  if (!owner) return 'Not set';
  if (owner.resolution === 'resolved') {
    const name = [owner.first_name, owner.last_name].filter((part) => part && part.trim()).join(' ');
    const display = name || owner.email || `ID ${owner.owner_id}`;
    return owner.archived ? `${display} (archived)` : display;
  }
  return `${OWNER_DETAILS_UNAVAILABLE} (ID ${owner.owner_id})`;
}

// Fixed en-US formatting; UTC so a HubSpot midnight-UTC close date never
// shifts to the previous day in a western timezone.
export function formatDealDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// ---- DRUID enrichment ----------------------------------------------------

// Small factual context only. HubSpot association remains deal-membership
// truth; this is never presented as the deal's source.
export function formatDruidRecord(record: PamCommercialDruidOpportunity): string {
  const parts = [record.name, record.status.replace(/_/g, ' '), record.attribution_type.replace(/_/g, ' ')];
  try {
    parts.push(new Intl.NumberFormat('en-US', { style: 'currency', currency: record.currency, maximumFractionDigits: 0 }).format(record.deal_value));
  } catch {
    parts.push(`${record.deal_value} ${record.currency}`);
  }
  if (record.assigned_user_name) parts.push(record.assigned_user_name);
  return parts.join(' · ');
}
