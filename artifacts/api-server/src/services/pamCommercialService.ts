// PAM Commercial Workspace v1 (Slice B): the factual, read-only commercial
// API behind the human PAM workspace (routes/pam_commercial.ts). Human
// session auth only -- never the Channel Chief service token.
//
// Canonical rules (same as pamOverviewService.ts):
// - Ownership: partner_relationships.assigned_user_id. Territory is context
//   only, never a substitute for relationship assignment.
// - active/dormant are confirmed partners; needs_review is CRM/opportunity
//   evidence awaiting confirmation and is always kept separate; closed is
//   historical and excluded from the current workspace.
//
// HubSpot rules:
// - The workspace listing is DB-only. HubSpot is read lazily, per
//   relationship, only after the relationship has been loaded, authorized
//   and found eligible.
// - The live HubSpot company -> deal association defines deal membership.
//   DRUID partner_opportunities only ever enrich a deal HubSpot already
//   returned; they never add or remove deals.
// - Every HubSpot read goes through the Slice A GET-only primitives in
//   hubspot.ts, and every interpretation through hubspotDealFacts.ts. No
//   writes, caching, snapshots or AI; nothing here scores, ranks or judges.
// - unknown != zero: "0 deals" is only ever stated after a successful
//   association lookup that returned none.
import { db } from "@workspace/db";
import {
  companiesTable,
  territoriesTable,
  usersTable,
  partnerRelationshipsTable,
  partnerOpportunitiesTable,
  type User,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { isGlobalUser, assertOwnUserAccess, ForbiddenScopeError, type ActingUser } from "./authz";
import { resolveProviderSecret } from "./connections";
import { EncryptionKeyMissingError, EncryptionKeyMalformedError, SecretDecryptionError } from "./encryption";
import {
  getDealWithHistory,
  getOwner,
  listCompanyDealAssociations,
  listDealPipelines,
  HubSpotInputError,
  HubSpotProviderError,
  type HubSpotDealWithHistory,
  type HubSpotOwner,
} from "./hubspot";
import {
  buildDealPipelineIndex,
  deriveDealState,
  normalizeDealHistory,
  parseHubSpotDate,
  type DealHistoryEvent,
  type DealPipelineIndex,
  type DealState,
} from "./hubspotDealFacts";

// ---------------------------------------------------------------------------
// Relationship eligibility
// ---------------------------------------------------------------------------

type RelationshipStatus = (typeof partnerRelationshipsTable.$inferSelect)["status"];

const CONFIRMED_STATUSES: ReadonlySet<RelationshipStatus> = new Set(["active", "dormant"]);
const AWAITING_REVIEW_STATUS: RelationshipStatus = "needs_review";

export function isConfirmedPartnerStatus(status: RelationshipStatus): boolean {
  return CONFIRMED_STATUSES.has(status);
}

// closed is historical and never part of the current commercial workspace.
export function isCommercialWorkspaceStatus(status: RelationshipStatus): boolean {
  return isConfirmedPartnerStatus(status) || status === AWAITING_REVIEW_STATUS;
}

export class RelationshipNotEligibleError extends Error {
  constructor() {
    super("This relationship is closed and is not part of the current commercial workspace.");
    this.name = "RelationshipNotEligibleError";
  }
}

// ---------------------------------------------------------------------------
// Authorization (reuses authz.ts; no second model)
// ---------------------------------------------------------------------------

export class PamSelectionRequiredError extends Error {
  constructor() {
    super("pam_user_id is required to select a PAM's commercial workspace.");
    this.name = "PamSelectionRequiredError";
  }
}

// A PAM only ever sees their own workspace; supplying another user's ID is
// rejected rather than silently ignored. Global roles (authz.GLOBAL_ROLES)
// have no workspace of their own and must select a PAM explicitly.
export function resolveCommercialWorkspaceUserId(actingUser: ActingUser, requestedPamUserId: string | null | undefined): string {
  const requested = requestedPamUserId?.trim() || null;
  if (isGlobalUser(actingUser)) {
    if (!requested) throw new PamSelectionRequiredError();
    return requested;
  }
  if (requested && requested !== actingUser.id) {
    throw new ForbiddenScopeError("You do not have access to that PAM's commercial workspace.");
  }
  return actingUser.id;
}

// Relationship-level access is assignment, never territory: a PAM who owns
// the territory but is not the assignee has no access.
export function assertCommercialRelationshipAccess(actingUser: ActingUser, relationship: { assignedUserId: string | null }): void {
  assertOwnUserAccess(actingUser, relationship.assignedUserId);
}

// ---------------------------------------------------------------------------
// Workspace listing (DB-only)
// ---------------------------------------------------------------------------

export type HubSpotLinkStatus = "linked" | "not_linked";

export interface CommercialRelationship {
  relationship_id: string;
  company_id: string;
  company_name: string;
  company_domain: string | null;
  territory_id: string;
  territory_name: string | null;
  status: RelationshipStatus;
  confirmed_partner: boolean;
  assigned_user_id: string | null;
  hubspot_company_id: string | null;
  // not_linked means commercial activity is unknown -- never "0 deals".
  hubspot_link_status: HubSpotLinkStatus;
}

export interface PamCommercialWorkspace {
  pam: { user_id: string; name: string; email: string; role: string; active: boolean };
  ownership_basis: "partner_relationships.assigned_user_id";
  hubspot_read: "not_performed";
  confirmed_relationships: CommercialRelationship[];
  awaiting_review: CommercialRelationship[];
}

function normalizeHubSpotCompanyId(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function shapeCommercialRelationship(
  relationship: typeof partnerRelationshipsTable.$inferSelect,
  company: typeof companiesTable.$inferSelect,
  territory: typeof territoriesTable.$inferSelect | null,
): CommercialRelationship {
  const hubspotCompanyId = normalizeHubSpotCompanyId(company.hubspotCompanyId);
  return {
    relationship_id: relationship.id,
    company_id: company.id,
    company_name: company.name,
    company_domain: company.domain,
    territory_id: relationship.territoryId,
    territory_name: territory?.name ?? null,
    status: relationship.status,
    confirmed_partner: isConfirmedPartnerStatus(relationship.status),
    assigned_user_id: relationship.assignedUserId,
    hubspot_company_id: hubspotCompanyId,
    hubspot_link_status: hubspotCompanyId ? "linked" : "not_linked",
  };
}

export async function getPamCommercialWorkspace(pam: User): Promise<PamCommercialWorkspace> {
  const rows = await db
    .select({ relationship: partnerRelationshipsTable, company: companiesTable, territory: territoriesTable })
    .from(partnerRelationshipsTable)
    .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(partnerRelationshipsTable.territoryId, territoriesTable.id))
    .where(eq(partnerRelationshipsTable.assignedUserId, pam.id))
    .orderBy(asc(companiesTable.name), asc(partnerRelationshipsTable.id));

  const shaped = rows
    .filter((r) => isCommercialWorkspaceStatus(r.relationship.status))
    .map((r) => shapeCommercialRelationship(r.relationship, r.company, r.territory));

  return {
    pam: { user_id: pam.id, name: pam.name, email: pam.email, role: pam.role, active: pam.active },
    ownership_basis: "partner_relationships.assigned_user_id",
    hubspot_read: "not_performed",
    confirmed_relationships: shaped.filter((r) => r.confirmed_partner),
    awaiting_review: shaped.filter((r) => r.status === AWAITING_REVIEW_STATUS),
  };
}

export async function loadCommercialRelationship(relationshipId: string) {
  const [row] = await db
    .select({ relationship: partnerRelationshipsTable, company: companiesTable, territory: territoriesTable })
    .from(partnerRelationshipsTable)
    .innerJoin(companiesTable, eq(partnerRelationshipsTable.companyId, companiesTable.id))
    .leftJoin(territoriesTable, eq(partnerRelationshipsTable.territoryId, territoriesTable.id))
    .where(eq(partnerRelationshipsTable.id, relationshipId));
  return row ? shapeCommercialRelationship(row.relationship, row.company, row.territory) : null;
}

// ---------------------------------------------------------------------------
// DRUID opportunity enrichment (DB)
// ---------------------------------------------------------------------------

// Only source_system="hubspot" structurally establishes that external_id is
// a HubSpot deal ID. "import" rows are excluded: the importer stores either a
// matched HubSpot deal ID, a CSV-supplied external_id, or a generated
// CUTOVER-* ID under the same source, with no persisted field recording
// which -- so an equal external_id there is not proof of deal identity.
// Every match is returned; none is silently chosen.
const DEAL_ID_SOURCE_SYSTEMS = ["hubspot"] as const;

export interface DruidOpportunityRow {
  opportunity: typeof partnerOpportunitiesTable.$inferSelect;
  companyName: string | null;
  assignedUserName: string | null;
}

export async function loadDruidOpportunitiesByDealIds(dealIds: readonly string[]): Promise<DruidOpportunityRow[]> {
  if (dealIds.length === 0) return [];
  const rows = await db
    .select({ opportunity: partnerOpportunitiesTable, company: companiesTable, assignedUser: usersTable })
    .from(partnerOpportunitiesTable)
    .leftJoin(companiesTable, eq(partnerOpportunitiesTable.companyId, companiesTable.id))
    .leftJoin(usersTable, eq(partnerOpportunitiesTable.assignedUserId, usersTable.id))
    .where(
      and(
        inArray(partnerOpportunitiesTable.sourceSystem, [...DEAL_ID_SOURCE_SYSTEMS]),
        inArray(partnerOpportunitiesTable.externalId, [...dealIds]),
      ),
    )
    .orderBy(asc(partnerOpportunitiesTable.sourceSystem), asc(partnerOpportunitiesTable.id));
  return rows.map((r) => ({ opportunity: r.opportunity, companyName: r.company?.name ?? null, assignedUserName: r.assignedUser?.name ?? null }));
}

export interface CommercialDruidOpportunity {
  opportunity_id: string;
  name: string;
  source_system: string;
  external_id: string | null;
  company_id: string;
  company_name: string | null;
  // Whether DRUID recorded this opportunity against the same company as the
  // relationship. A factual comparison only; a mismatch never removes the deal.
  same_company_as_relationship: boolean;
  territory_id: string;
  assigned_user_id: string;
  assigned_user_name: string | null;
  attribution_type: string;
  status: string;
  deal_value: number;
  currency: string;
  opportunity_date: string;
  expected_close_date: string | null;
  closed_at: string | null;
  source_updated_at: string | null;
  last_synced_at: string | null;
}

export interface CommercialDruidEnrichment {
  // no_match means no matching DRUID record visible to this viewer -- never
  // that the deal does not exist.
  match_status: "matched" | "no_match";
  records: CommercialDruidOpportunity[];
}

function shapeDruidOpportunity(row: DruidOpportunityRow, relationshipCompanyId: string): CommercialDruidOpportunity {
  const o = row.opportunity;
  return {
    opportunity_id: o.id,
    name: o.name,
    source_system: o.sourceSystem,
    external_id: o.externalId,
    company_id: o.companyId,
    company_name: row.companyName,
    same_company_as_relationship: o.companyId === relationshipCompanyId,
    territory_id: o.territoryId,
    assigned_user_id: o.assignedUserId,
    assigned_user_name: row.assignedUserName,
    attribution_type: o.attributionType,
    status: o.status,
    deal_value: Number(o.dealValue),
    currency: o.currency,
    opportunity_date: o.opportunityDate,
    expected_close_date: o.expectedCloseDate,
    closed_at: o.closedAt ? o.closedAt.toISOString() : null,
    source_updated_at: o.sourceUpdatedAt ? o.sourceUpdatedAt.toISOString() : null,
    last_synced_at: o.lastSyncedAt ? o.lastSyncedAt.toISOString() : null,
  };
}

// Same visibility rule as GET /opportunities: global roles see all, anyone
// else only opportunities assigned to them. Records outside that scope are
// simply absent -- their existence is never signalled.
function buildEnrichment(
  dealId: string,
  rows: readonly DruidOpportunityRow[],
  actingUser: ActingUser,
  relationshipCompanyId: string,
): CommercialDruidEnrichment {
  const visible = rows.filter(
    (r) => r.opportunity.externalId === dealId && (isGlobalUser(actingUser) || r.opportunity.assignedUserId === actingUser.id),
  );
  return {
    match_status: visible.length > 0 ? "matched" : "no_match",
    records: visible.map((r) => shapeDruidOpportunity(r, relationshipCompanyId)),
  };
}

// ---------------------------------------------------------------------------
// HubSpot availability / error classification
// ---------------------------------------------------------------------------

export type CommercialHubSpotAvailability =
  | "not_linked"
  | "available"
  | "not_configured"
  | "credential_error"
  | "authentication_failed"
  | "permission_denied"
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "hubspot_company_not_found"
  | "invalid_hubspot_company_id";

type ProviderFailure = "authentication_failed" | "permission_denied" | "rate_limited" | "timeout" | "not_found" | "provider_error";

export type CommercialDealError = ProviderFailure | "invalid_deal_id";

// Fixed, credential-free messages. Raw provider text is never returned.
const AVAILABILITY_MESSAGES: Record<CommercialHubSpotAvailability, string> = {
  not_linked: "HubSpot not linked -- commercial activity unknown.",
  available: "HubSpot company deal associations were read successfully.",
  not_configured: "The HubSpot integration is not configured or is disabled -- commercial activity unknown.",
  credential_error: "The stored HubSpot credential could not be read -- commercial activity unknown.",
  authentication_failed: "HubSpot authentication failed -- commercial activity unknown.",
  permission_denied: "HubSpot denied access -- commercial activity unknown.",
  rate_limited: "HubSpot rate limit reached -- commercial activity unknown. Try again later.",
  timeout: "HubSpot timed out -- commercial activity unknown. Try again later.",
  provider_error: "HubSpot could not be read -- commercial activity unknown.",
  hubspot_company_not_found: "The linked HubSpot company was not found in HubSpot -- commercial activity unknown.",
  invalid_hubspot_company_id: "The stored HubSpot company ID is not a valid HubSpot ID -- commercial activity unknown.",
};

function classifyProviderError(error: unknown): ProviderFailure | null {
  if (!(error instanceof HubSpotProviderError)) return null;
  switch (error.code) {
    case "authentication_error":
      return "authentication_failed";
    case "permission_error":
      return "permission_denied";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "not_found":
      return "not_found";
    case "network_error":
    case "malformed_json":
    case "malformed_response":
    case "http_error":
      return "provider_error";
  }
}

function isCredentialError(error: unknown): boolean {
  return error instanceof EncryptionKeyMissingError || error instanceof EncryptionKeyMalformedError || error instanceof SecretDecryptionError;
}

// ---------------------------------------------------------------------------
// Relationship deals (lazy HubSpot read)
// ---------------------------------------------------------------------------

export interface CommercialCrmOwner {
  owner_id: string;
  // CRM owner from HubSpot. Never PAM ownership (see assigned_user_id).
  resolution: "resolved" | "not_found" | "unavailable";
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  archived: boolean | null;
}

export interface CommercialDealHistoryEvent {
  property: DealHistoryEvent["property"];
  kind: DealHistoryEvent["kind"];
  previous_value: string | null;
  new_value: string | null;
  previous_label: string | null;
  new_label: string | null;
  changed_at: string;
  source_type: string | null;
}

export interface CommercialDealFacts {
  deal_name: string | null;
  amount: string | null;
  currency: string | null;
  pipeline: { id: string | null; label: string | null };
  stage: { id: string | null; label: string | null };
  deal_state: DealState;
  close_date: string | null;
  create_date: string | null;
  last_modified_at: string | null;
  crm_owner: CommercialCrmOwner | null;
  associated_companies: Array<{ hubspot_company_id: string; association_types: string[] }>;
  associated_companies_truncated: boolean;
  property_history: CommercialDealHistoryEvent[];
}

export interface CommercialDeal {
  deal_id: string;
  association_types: string[];
  load_status: "loaded" | "unavailable";
  error: CommercialDealError | null;
  facts: CommercialDealFacts | null;
  druid_opportunities: CommercialDruidEnrichment;
}

export interface CommercialRelationshipDeals {
  relationship: CommercialRelationship;
  hubspot: {
    availability: CommercialHubSpotAvailability;
    message: string;
  };
  // Present only when availability is "available". returned_count is the
  // number of deals returned, never HubSpot's total: when truncated is true
  // the full association count is unknown.
  association: { returned_count: number; truncated: boolean } | null;
  pipeline_metadata: "available" | "unavailable" | "not_requested";
  // null = unknown (not linked / unavailable). [] = known zero associations.
  deals: CommercialDeal[] | null;
}

export interface CommercialDealsDependencies {
  resolveAccessToken(): Promise<string | null>;
  listCompanyDealAssociations: typeof listCompanyDealAssociations;
  getDealWithHistory: typeof getDealWithHistory;
  listDealPipelines: typeof listDealPipelines;
  getOwner: typeof getOwner;
  loadDruidOpportunitiesByDealIds(dealIds: readonly string[]): Promise<DruidOpportunityRow[]>;
}

export const defaultCommercialDealsDependencies: CommercialDealsDependencies = {
  resolveAccessToken: () => resolveProviderSecret("hubspot"),
  listCompanyDealAssociations,
  getDealWithHistory,
  listDealPipelines,
  getOwner,
  loadDruidOpportunitiesByDealIds,
};

// Bounded per-request fan-out for deal/owner reads. Results keep input order.
export const COMMERCIAL_READ_CONCURRENCY = 4;

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

type DealRead = { dealId: string; deal: HubSpotDealWithHistory } | { dealId: string; error: CommercialDealError };

async function readDeal(deps: CommercialDealsDependencies, token: string, dealId: string): Promise<DealRead> {
  try {
    return { dealId, deal: await deps.getDealWithHistory(token, dealId) };
  } catch (error) {
    if (error instanceof HubSpotInputError) return { dealId, error: "invalid_deal_id" };
    const failure = classifyProviderError(error);
    if (failure) return { dealId, error: failure };
    throw error;
  }
}

async function readPipelineIndex(deps: CommercialDealsDependencies, token: string): Promise<DealPipelineIndex | null> {
  try {
    return buildDealPipelineIndex(await deps.listDealPipelines(token));
  } catch (error) {
    if (classifyProviderError(error)) return null;
    throw error;
  }
}

type OwnerRead = { owner: HubSpotOwner } | { resolution: "not_found" | "unavailable" };

async function readOwner(deps: CommercialDealsDependencies, token: string, ownerId: string): Promise<OwnerRead> {
  try {
    const owner = await deps.getOwner(token, ownerId);
    return owner ? { owner } : { resolution: "not_found" };
  } catch (error) {
    if (error instanceof HubSpotInputError || classifyProviderError(error)) return { resolution: "unavailable" };
    throw error;
  }
}

function toCrmOwner(ownerId: string | null, read: OwnerRead | undefined): CommercialCrmOwner | null {
  if (!ownerId) return null;
  if (read && "owner" in read) {
    return {
      owner_id: ownerId,
      resolution: "resolved",
      first_name: read.owner.firstName,
      last_name: read.owner.lastName,
      email: read.owner.email,
      archived: read.owner.archived,
    };
  }
  return {
    owner_id: ownerId,
    resolution: read?.resolution ?? "unavailable",
    first_name: null,
    last_name: null,
    email: null,
    archived: null,
  };
}

function toDealFacts(deal: HubSpotDealWithHistory, index: DealPipelineIndex | null, owners: Map<string, OwnerRead>): CommercialDealFacts {
  const p = deal.properties;
  const pipelineId = p.pipeline;
  const stageId = p.dealstage;
  const ownerId = p.hubspot_owner_id?.trim() || null;
  return {
    deal_name: p.dealname,
    amount: p.amount,
    currency: p.deal_currency_code,
    pipeline: { id: pipelineId, label: index?.resolvePipeline(pipelineId)?.label ?? null },
    stage: { id: stageId, label: index?.resolveStage(stageId, pipelineId)?.label ?? null },
    deal_state: deriveDealState(p),
    close_date: parseHubSpotDate(p.closedate),
    create_date: parseHubSpotDate(p.createdate),
    last_modified_at: parseHubSpotDate(p.hs_lastmodifieddate),
    crm_owner: toCrmOwner(ownerId, ownerId ? owners.get(ownerId) : undefined),
    associated_companies: deal.companies.map((c) => ({ hubspot_company_id: c.id, association_types: c.associationTypes })),
    associated_companies_truncated: deal.companiesHasMore,
    property_history: normalizeDealHistory(deal.propertiesWithHistory, index).map((e) => ({
      property: e.property,
      kind: e.kind,
      previous_value: e.previousValue,
      new_value: e.newValue,
      previous_label: e.previousLabel,
      new_label: e.newLabel,
      changed_at: e.changedAt,
      source_type: e.sourceType,
    })),
  };
}

function unavailable(relationship: CommercialRelationship, availability: CommercialHubSpotAvailability): CommercialRelationshipDeals {
  return {
    relationship,
    hubspot: { availability, message: AVAILABILITY_MESSAGES[availability] },
    association: null,
    pipeline_metadata: "not_requested",
    deals: null,
  };
}

// Reads the live HubSpot deal set for an already-authorized, eligible
// relationship. Callers must have run assertCommercialRelationshipAccess and
// isCommercialWorkspaceStatus first (see getRelationshipDealsForUser).
export async function readRelationshipDeals(
  relationship: CommercialRelationship,
  actingUser: ActingUser,
  deps: CommercialDealsDependencies = defaultCommercialDealsDependencies,
): Promise<CommercialRelationshipDeals> {
  const hubspotCompanyId = relationship.hubspot_company_id;
  if (!hubspotCompanyId) return unavailable(relationship, "not_linked");

  let resolvedToken: string | null;
  try {
    resolvedToken = await deps.resolveAccessToken();
  } catch (error) {
    if (isCredentialError(error)) return unavailable(relationship, "credential_error");
    throw error;
  }
  if (!resolvedToken) return unavailable(relationship, "not_configured");
  const token = resolvedToken;

  let associations;
  try {
    associations = await deps.listCompanyDealAssociations(token, hubspotCompanyId);
  } catch (error) {
    if (error instanceof HubSpotInputError) return unavailable(relationship, "invalid_hubspot_company_id");
    const failure = classifyProviderError(error);
    if (failure === "not_found") return unavailable(relationship, "hubspot_company_not_found");
    if (failure) return unavailable(relationship, failure);
    throw error;
  }

  // Slice A already merges duplicate association rows; this keeps one entry
  // per deal ID regardless, unioning association-type evidence.
  const byDealId = new Map<string, string[]>();
  for (const row of associations.deals) {
    const types = byDealId.get(row.dealId) ?? [];
    for (const type of row.associationTypes) if (!types.includes(type)) types.push(type);
    byDealId.set(row.dealId, types);
  }
  const dealIds = [...byDealId.keys()];

  const base = {
    relationship,
    hubspot: { availability: "available" as const, message: AVAILABILITY_MESSAGES.available },
    association: { returned_count: dealIds.length, truncated: associations.truncated },
  };
  if (dealIds.length === 0) return { ...base, pipeline_metadata: "not_requested", deals: [] };

  const [pipelineIndex, dealReads, druidRows] = await Promise.all([
    readPipelineIndex(deps, token),
    mapWithConcurrency(dealIds, COMMERCIAL_READ_CONCURRENCY, (id) => readDeal(deps, token, id)),
    deps.loadDruidOpportunitiesByDealIds(dealIds),
  ]);

  const ownerIds = [
    ...new Set(dealReads.flatMap((r) => ("deal" in r ? [r.deal.properties.hubspot_owner_id?.trim() || null] : [])).filter((id): id is string => !!id)),
  ].sort();
  const ownerReads = await mapWithConcurrency(ownerIds, COMMERCIAL_READ_CONCURRENCY, (id) => readOwner(deps, token, id));
  const owners = new Map(ownerIds.map((id, i) => [id, ownerReads[i]!]));

  const deals = dealReads.map((read): CommercialDeal => ({
    deal_id: read.dealId,
    association_types: byDealId.get(read.dealId) ?? [],
    load_status: "deal" in read ? "loaded" : "unavailable",
    error: "deal" in read ? null : read.error,
    facts: "deal" in read ? toDealFacts(read.deal, pipelineIndex, owners) : null,
    druid_opportunities: buildEnrichment(read.dealId, druidRows, actingUser, relationship.company_id),
  }));

  return { ...base, pipeline_metadata: pipelineIndex ? "available" : "unavailable", deals };
}

export class CommercialRelationshipNotFoundError extends Error {
  constructor() {
    super("Partner relationship not found");
    this.name = "CommercialRelationshipNotFoundError";
  }
}

// Load -> authorize -> check eligibility -> (only then) read HubSpot.
export async function getRelationshipDealsForUser(
  relationshipId: string,
  actingUser: ActingUser,
  deps: CommercialDealsDependencies = defaultCommercialDealsDependencies,
): Promise<CommercialRelationshipDeals> {
  const relationship = await loadCommercialRelationship(relationshipId);
  if (!relationship) throw new CommercialRelationshipNotFoundError();
  assertCommercialRelationshipAccess(actingUser, { assignedUserId: relationship.assigned_user_id });
  if (!isCommercialWorkspaceStatus(relationship.status)) throw new RelationshipNotEligibleError();
  return readRelationshipDeals(relationship, actingUser, deps);
}
