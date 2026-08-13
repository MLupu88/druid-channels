import { db } from "@workspace/db";
import { campaignOpportunitiesTable, partnerOpportunitiesTable, campaignsTable } from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";
import {
  isGlobalUser,
  getOwnTerritory,
  ForbiddenScopeError,
  type ActingUser,
} from "./authz";
import { resolveFx, type SupportedCurrency } from "./fx";
import { buildUsdRateMap, usdValueOf, convertMoney } from "./kpiService";

export class CampaignValidationError extends Error {}

export interface CampaignMoneyAmount {
  amount: number;
  currency: SupportedCurrency;
}

export interface CampaignCommercialImpact {
  linkedOpportunityIds: string[];
  linkedOpportunityCount: number;
  linkedOpenPipeline: CampaignMoneyAmount | null;
  linkedClosedRevenue: CampaignMoneyAmount | null;
}

type OpportunityRow = typeof partnerOpportunitiesTable.$inferSelect;

// A caller's visibility context, resolved ONCE per request rather than
// per-opportunity -- mirrors routes/opportunities.ts's assertPamOwnsOpportunity
// (own territory AND own assignment), but as a reusable predicate instead of
// a throw, since commercial-impact computation must SILENTLY drop
// inaccessible opportunities from the count/sum rather than fail the whole
// request (see rule: "Do not expose another PAM's opportunities to a PAM").
export interface VisibilityContext {
  global: boolean;
  territoryId: string | null;
  userId: string;
}

async function resolveVisibilityContext(actingUser: ActingUser): Promise<VisibilityContext> {
  if (isGlobalUser(actingUser)) return { global: true, territoryId: null, userId: actingUser.id };
  const own = await getOwnTerritory(actingUser.id);
  return { global: false, territoryId: own?.territoryId ?? null, userId: actingUser.id };
}

// Exported (alongside VisibilityContext) purely so tests/campaignVisibility.test.ts
// can exercise this rule directly without a database -- it is the single
// place "can this caller see this opportunity" is decided, so a DB-free
// unit test on it is worth more than leaving it only reachable through a
// full integration test.
export function isOpportunityVisible(ctx: VisibilityContext, opp: Pick<OpportunityRow, "territoryId" | "assignedUserId">): boolean {
  if (ctx.global) return true;
  return opp.territoryId === ctx.territoryId && opp.assignedUserId === ctx.userId;
}

// Same two checks as isOpportunityVisible, but throwing -- used when the
// caller is actively trying to LINK a specific opportunity (create/update),
// where an inaccessible request must be a 403, not a silent drop.
function assertOpportunityLinkable(ctx: VisibilityContext, opp: Pick<OpportunityRow, "territoryId" | "assignedUserId">): void {
  if (!isOpportunityVisible(ctx, opp)) {
    throw new ForbiddenScopeError("You are not authorized to link this opportunity.");
  }
}

/**
 * Validates a requested opportunity_ids set against the activity's partner
 * and the caller's access, WITHOUT writing anything. Every opportunity must:
 *  - exist
 *  - belong to the campaign's partner_company_id (company_id match)
 *  - be one the caller is authorized to access (own territory + own
 *    assignment for a PAM; unrestricted for Head/Admin)
 * Returns the validated, de-duplicated set of opportunity rows. Throws
 * CampaignValidationError (-> 400) for shape/partner mismatches and
 * ForbiddenScopeError (-> 403) for access violations -- callers map these
 * the same way routes/opportunities.ts already does.
 */
export async function validateOpportunityLinks(
  actingUser: ActingUser,
  partnerCompanyId: string | null,
  opportunityIds: string[],
): Promise<OpportunityRow[]> {
  const distinctIds = [...new Set(opportunityIds)];
  if (distinctIds.length === 0) return [];

  if (!partnerCompanyId) {
    throw new CampaignValidationError("Cannot link opportunities to an activity with no partner.");
  }

  const rows = await db.select().from(partnerOpportunitiesTable).where(inArray(partnerOpportunitiesTable.id, distinctIds));
  if (rows.length !== distinctIds.length) {
    throw new CampaignValidationError("One or more selected opportunities do not exist.");
  }

  const mismatched = rows.some((r) => r.companyId !== partnerCompanyId);
  if (mismatched) {
    throw new CampaignValidationError("Selected opportunities must belong to this activity's partner.");
  }

  const ctx = await resolveVisibilityContext(actingUser);
  for (const opp of rows) {
    assertOpportunityLinkable(ctx, opp);
  }

  return rows;
}

/**
 * Replaces the full campaign_opportunities set for a campaign with exactly
 * `opportunityIds` (already validated by validateOpportunityLinks). Never
 * touches partner_opportunities itself -- only this join table.
 */
export async function replaceCampaignOpportunityLinks(campaignId: string, opportunityIds: string[]): Promise<void> {
  const distinctIds = [...new Set(opportunityIds)];

  await db.transaction(async (tx) => {
    await tx.delete(campaignOpportunitiesTable).where(eq(campaignOpportunitiesTable.campaignId, campaignId));
    if (distinctIds.length > 0) {
      await tx.insert(campaignOpportunitiesTable).values(distinctIds.map((opportunityId) => ({ campaignId, opportunityId })));
    }
  });
}

// Batch-fetches every campaign_opportunities row for the given campaigns in
// one query, then the referenced opportunity rows in one more -- O(1) query
// pairs regardless of list size, matching the batching pattern
// routes/opportunities.ts's shapeRows already uses.
async function fetchLinkedOpportunitiesByCampaign(campaignIds: string[]): Promise<Map<string, OpportunityRow[]>> {
  const byCampaign = new Map<string, OpportunityRow[]>();
  if (campaignIds.length === 0) return byCampaign;

  const links = await db
    .select()
    .from(campaignOpportunitiesTable)
    .where(inArray(campaignOpportunitiesTable.campaignId, campaignIds));
  if (links.length === 0) return byCampaign;

  const opportunityIds = [...new Set(links.map((l) => l.opportunityId))];
  const opportunities = await db
    .select()
    .from(partnerOpportunitiesTable)
    .where(inArray(partnerOpportunitiesTable.id, opportunityIds));
  const opportunityById = new Map(opportunities.map((o) => [o.id, o]));

  for (const link of links) {
    const opp = opportunityById.get(link.opportunityId);
    if (!opp) continue; // defensive: a dangling link row should never happen (FK+cascade), but never crash the list on it
    const list = byCampaign.get(link.campaignId) ?? [];
    list.push(opp);
    byCampaign.set(link.campaignId, list);
  }
  return byCampaign;
}

/**
 * Derives, for each campaign, the caller-visible linked opportunity IDs plus
 * currency-safe open pipeline / closed revenue -- computed fresh from
 * partner_opportunities.status/deal_value on every call, never persisted or
 * read from campaigns. Pipeline = status "open"; closed revenue = status
 * "won"; both always use the real deal_value, never credit_value.
 * closed_at is never read here (it drives nothing about this figure).
 *
 * Currency-safe: each opportunity's deal_value is first normalized to USD
 * (buildUsdRateMap/usdValueOf, the same multi-currency-safe path
 * kpiService.computeMetric uses), summed in USD, then converted ONCE to the
 * requested display currency via the existing resolveFx/convertMoney
 * contract -- never a naive cross-currency addition.
 */
export async function computeCommercialImpact(
  campaignIds: string[],
  actingUser: ActingUser,
  currency: SupportedCurrency,
): Promise<Map<string, CampaignCommercialImpact>> {
  const result = new Map<string, CampaignCommercialImpact>();
  const byCampaign = await fetchLinkedOpportunitiesByCampaign(campaignIds);
  const ctx = await resolveVisibilityContext(actingUser);

  const allCurrencies = new Set<string>();
  for (const opps of byCampaign.values()) {
    for (const o of opps) {
      if (isOpportunityVisible(ctx, o)) allCurrencies.add(o.currency);
    }
  }
  const usdRateByCurrency = await buildUsdRateMap(allCurrencies);
  const fx = await resolveFx(currency);

  for (const campaignId of campaignIds) {
    const opps = (byCampaign.get(campaignId) ?? []).filter((o) => isOpportunityVisible(ctx, o));

    let openUsd = 0;
    let wonUsd = 0;
    let hasOpen = false;
    let hasWon = false;
    for (const o of opps) {
      const usd = usdValueOf(o, usdRateByCurrency);
      if (o.status === "open") {
        openUsd += usd;
        hasOpen = true;
      } else if (o.status === "won") {
        wonUsd += usd;
        hasWon = true;
      }
    }

    result.set(campaignId, {
      linkedOpportunityIds: opps.map((o) => o.id),
      linkedOpportunityCount: opps.length,
      linkedOpenPipeline: hasOpen ? { amount: convertMoney(openUsd, fx.usd_to_currency_rate)!, currency } : null,
      linkedClosedRevenue: hasWon ? { amount: convertMoney(wonUsd, fx.usd_to_currency_rate)!, currency } : null,
    });
  }

  return result;
}

export async function getCampaignOwnerPartner(campaignId: string): Promise<{ ownerUserId: string; partnerCompanyId: string | null } | null> {
  const [row] = await db
    .select({ ownerUserId: campaignsTable.ownerUserId, partnerCompanyId: campaignsTable.partnerCompanyId })
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId));
  return row ?? null;
}

/**
 * When an edit changes partner_company_id, every currently-linked
 * opportunity must still belong to the new partner -- otherwise the link
 * silently becomes commercially nonsensical (an activity claiming pipeline
 * from a different partner's deal). Callers must reject the edit (400)
 * rather than auto-unlinking, so the PAM makes an explicit choice.
 */
export async function assertPartnerChangeCompatibleWithLinks(campaignId: string, newPartnerCompanyId: string | null): Promise<void> {
  const links = await db
    .select({ opportunityId: campaignOpportunitiesTable.opportunityId })
    .from(campaignOpportunitiesTable)
    .where(eq(campaignOpportunitiesTable.campaignId, campaignId));
  if (links.length === 0) return;

  if (!newPartnerCompanyId) {
    throw new CampaignValidationError("Cannot remove this activity's partner while opportunities are linked. Unlink them first.");
  }

  const opportunityIds = links.map((l) => l.opportunityId);
  const rows = await db
    .select({ id: partnerOpportunitiesTable.id, companyId: partnerOpportunitiesTable.companyId })
    .from(partnerOpportunitiesTable)
    .where(and(inArray(partnerOpportunitiesTable.id, opportunityIds), eq(partnerOpportunitiesTable.companyId, newPartnerCompanyId)));

  if (rows.length !== opportunityIds.length) {
    throw new CampaignValidationError(
      "This activity has opportunities linked that do not belong to the new partner. Unlink them first.",
    );
  }
}
