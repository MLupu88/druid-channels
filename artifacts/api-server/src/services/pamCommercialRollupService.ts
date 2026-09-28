// Slice E: Head of Channels / Aniri commercial roll-up. One DB-only
// management view, consumed verbatim by both the human Head/Admin route
// (GET /pam-commercial/rollup, routes/pam_commercial.ts) and the Aniri
// route (GET /channel-chief/pam-commercial-rollup, routes/channel_chief.ts)
// so the two can never drift apart.
//
// Semantics are reused, never re-derived:
// - Relationship status buckets and CRM linkage come from the pure
//   pamCommercialSemantics.ts (isConfirmedPartnerStatus /
//   isCommercialWorkspaceStatus / normalizeHubSpotCompanyId) -- the same
//   module the per-PAM Commercial workspace uses.
// - The active PAM roster and territories[] come from pamDirectoryService.ts.
//
// Truth boundary:
// - Ownership is partner_relationships.assigned_user_id only. A territory
//   owner is never credited with a relationship they are not assigned;
//   territories[] is context. Unassigned relationships stay unassigned, and
//   relationships assigned to anyone who is not an active PAM are reported
//   in their own bucket rather than dropped or re-attributed.
// - closed is historical and excluded from every count here.
// - A HubSpot company ID means "CRM linked" -- never "has deals". This
//   service never calls HubSpot, never reads cached deal data, and exposes
//   no deal count, pipeline, revenue, health or score. Live deals are only
//   ever read lazily, per relationship, via the existing PAM Commercial
//   deal endpoint.
import { db, companiesTable, partnerRelationshipsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getPamDirectory } from "./pamDirectoryService";
import type { PamTerritory } from "./pamOverviewService";
import {
  isConfirmedPartnerStatus,
  isCommercialWorkspaceStatus,
  normalizeHubSpotCompanyId,
  type RelationshipStatus,
} from "./pamCommercialSemantics";

const CURRENT_STATUSES: RelationshipStatus[] = ["active", "dormant", "needs_review"];

export interface PamCommercialRollupCounts {
  // active + dormant
  confirmed_partners: number;
  // needs_review -- evidence exists, relationship not confirmed
  awaiting_review: number;
  // Of the above, relationships whose company has a hubspot_company_id.
  // CRM linked only -- not a deal or opportunity count.
  crm_linked_confirmed: number;
  crm_linked_awaiting_review: number;
}

export interface PamCommercialRollupPam {
  pam_user_id: string;
  pam_name: string;
  pam_email: string;
  // Context only (territories.owner_user_id) -- never the basis of the counts.
  territories: PamTerritory[];
  counts: PamCommercialRollupCounts;
}

export interface PamCommercialRollup {
  ownership_basis: "partner_relationships.assigned_user_id";
  territory_basis: "context_only";
  hubspot_read: "not_performed";
  included_statuses: { confirmed: ["active", "dormant"]; awaiting_review: ["needs_review"]; excluded: ["closed"] };
  // Every current relationship: sum of pams[] + unassigned + other_assignees.
  totals: PamCommercialRollupCounts;
  // Every active PAM exactly once, including PAMs with zero relationships.
  pams: PamCommercialRollupPam[];
  // assigned_user_id IS NULL.
  unassigned: PamCommercialRollupCounts;
  // Assigned to a user who is not an active PAM (an inactive PAM, or a
  // head_of_channels/admin account) -- kept visible, never re-attributed.
  other_assignees: PamCommercialRollupCounts;
}

export interface RollupRelationshipFact {
  status: RelationshipStatus;
  assignedUserId: string | null;
  hubspotCompanyId: string | null;
}

function emptyCounts(): PamCommercialRollupCounts {
  return { confirmed_partners: 0, awaiting_review: 0, crm_linked_confirmed: 0, crm_linked_awaiting_review: 0 };
}

function addRelationship(counts: PamCommercialRollupCounts, fact: RollupRelationshipFact): void {
  const linked = normalizeHubSpotCompanyId(fact.hubspotCompanyId) !== null;
  if (isConfirmedPartnerStatus(fact.status)) {
    counts.confirmed_partners++;
    if (linked) counts.crm_linked_confirmed++;
  } else {
    counts.awaiting_review++;
    if (linked) counts.crm_linked_awaiting_review++;
  }
}

// Pure aggregation, exported for unit tests. `roster` is the active PAM
// directory; `relationships` may include closed rows (they are ignored).
export function buildPamCommercialRollup(
  roster: { pam_user_id: string; pam_name: string; pam_email: string; territories: PamTerritory[] }[],
  relationships: RollupRelationshipFact[],
): PamCommercialRollup {
  const pams: PamCommercialRollupPam[] = roster.map((p) => ({
    pam_user_id: p.pam_user_id,
    pam_name: p.pam_name,
    pam_email: p.pam_email,
    territories: p.territories,
    counts: emptyCounts(),
  }));
  const byPamId = new Map(pams.map((p) => [p.pam_user_id, p.counts]));
  const totals = emptyCounts();
  const unassigned = emptyCounts();
  const otherAssignees = emptyCounts();

  for (const fact of relationships) {
    if (!isCommercialWorkspaceStatus(fact.status)) continue;
    addRelationship(totals, fact);
    if (fact.assignedUserId === null) {
      addRelationship(unassigned, fact);
    } else {
      addRelationship(byPamId.get(fact.assignedUserId) ?? otherAssignees, fact);
    }
  }

  return {
    ownership_basis: "partner_relationships.assigned_user_id",
    territory_basis: "context_only",
    hubspot_read: "not_performed",
    included_statuses: { confirmed: ["active", "dormant"], awaiting_review: ["needs_review"], excluded: ["closed"] },
    totals,
    pams,
    unassigned,
    other_assignees: otherAssignees,
  };
}

export async function getPamCommercialRollup(): Promise<PamCommercialRollup> {
  const [roster, rows] = await Promise.all([
    getPamDirectory(),
    db
      .select({
        status: partnerRelationshipsTable.status,
        assignedUserId: partnerRelationshipsTable.assignedUserId,
        hubspotCompanyId: companiesTable.hubspotCompanyId,
      })
      .from(partnerRelationshipsTable)
      .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
      .where(inArray(partnerRelationshipsTable.status, CURRENT_STATUSES)),
  ]);
  return buildPamCommercialRollup(roster, rows);
}
