// Slice E: copy and pure helpers for the Head/Admin team commercial roll-up
// (pages/team-commercial.tsx). The roll-up is DB-only -- it never states a
// deal count, pipeline or revenue. "CRM linked" means a HubSpot company ID
// exists, nothing more.
import type { PamCommercialRollupCounts } from '@workspace/api-client-react';

export const ROLLUP_TOTAL_LABELS: Record<keyof PamCommercialRollupCounts, string> = {
  confirmed_partners: 'Confirmed partners',
  awaiting_review: 'Awaiting review',
  crm_linked_confirmed: 'CRM-linked confirmed',
  crm_linked_awaiting_review: 'CRM-linked awaiting review',
};

export const ROLLUP_COUNT_KEYS: (keyof PamCommercialRollupCounts)[] = [
  'confirmed_partners',
  'awaiting_review',
  'crm_linked_confirmed',
  'crm_linked_awaiting_review',
];

export const ROLLUP_SCOPE_NOTE =
  'Current Portfolio relationships by assigned PAM. Confirmed = active + dormant; awaiting review = needs_review, not confirmed partners; closed relationships are excluded.';

export const ROLLUP_CRM_NOTE =
  'CRM linked means the company has a HubSpot company ID — not that deals or active opportunities exist. Live deals are only loaded when you open a PAM and then one of their partners.';

export const UNASSIGNED_LABEL = 'Unassigned';
export const UNASSIGNED_NOTE = 'No PAM assigned — not attributed to the territory owner.';
export const OTHER_ASSIGNEES_LABEL = 'Assigned outside active PAMs';
export const OTHER_ASSIGNEES_NOTE = 'Assigned to an inactive PAM or a non-PAM account.';

export function hasRelationships(counts: PamCommercialRollupCounts): boolean {
  return counts.confirmed_partners > 0 || counts.awaiting_review > 0;
}

export function formatTerritories(territories: { territory_name: string }[]): string {
  return territories.length > 0 ? territories.map((t) => t.territory_name).join(', ') : '—';
}
