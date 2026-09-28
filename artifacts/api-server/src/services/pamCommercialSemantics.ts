// Pure, DB/network-free commercial relationship semantics shared by the
// per-PAM Commercial workspace (pamCommercialService.ts) and the team
// roll-up (pamCommercialRollupService.ts). One definition of the rules:
// - active/dormant are confirmed partners;
// - needs_review is evidence awaiting confirmation, never a partner;
// - closed is historical and outside the current commercial view;
// - a non-blank hubspot_company_id means "CRM linked" -- nothing more.
// Type-only import: nothing from @workspace/db is loaded at runtime.
import type { partnerRelationshipsTable } from "@workspace/db";

export type RelationshipStatus = (typeof partnerRelationshipsTable.$inferSelect)["status"];

const CONFIRMED_STATUSES: ReadonlySet<RelationshipStatus> = new Set(["active", "dormant"]);
export const AWAITING_REVIEW_STATUS: RelationshipStatus = "needs_review";

export function isConfirmedPartnerStatus(status: RelationshipStatus): boolean {
  return CONFIRMED_STATUSES.has(status);
}

// closed is historical and never part of the current commercial workspace.
export function isCommercialWorkspaceStatus(status: RelationshipStatus): boolean {
  return isConfirmedPartnerStatus(status) || status === AWAITING_REVIEW_STATUS;
}

export function normalizeHubSpotCompanyId(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
