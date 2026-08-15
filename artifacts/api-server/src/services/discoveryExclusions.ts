import { db } from "@workspace/db";
import { discoveryExclusionsTable, companiesTable, territoriesTable, usersTable, DISCOVERY_EXCLUSION_REASONS } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { toRegistrableDomain } from "./companyIdentity";

// Phase 11.5A: a PAM's "don't suggest this company again," and the Discovery
// pipeline's check against it. Deliberately narrow -- one table, one
// concept, territory-scoped to match the existing scan_configs.excludedDomains
// precedent. See discovery_exclusions.ts's schema comment for why this is
// not a generic archive concept and why "duplicate" is excluded from the
// reason enum.

export type DiscoveryExclusionReason = (typeof DISCOVERY_EXCLUSION_REASONS)[number];

export class InvalidExclusionReasonError extends Error {}

// Accepts either the module-level db or a transaction handle (db.transaction's
// tx) -- lets excludeCompanyForTerritory be composed into the same
// transaction as the prospect delete it's called alongside (see
// routes/prospects.ts), so a failure creating the exclusion rolls back the
// delete too, rather than leaving the prospect gone with no exclusion and a
// misleading 500 response. Same Executor pattern already used by
// partnerRelationshipService.ts/territoryOwnership.ts.
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbHandle = Db | Tx;

/**
 * Loads every currently-active exclusion domain for a territory, as a Set
 * for O(1) lookup -- called once per scan run (same convention as
 * discoveryEngine.ts's own knownDomainRecords cache), never per-candidate.
 */
export async function loadActiveExclusionDomains(territoryId: string): Promise<Set<string>> {
  const rows = await db
    .select({ domain: discoveryExclusionsTable.domain })
    .from(discoveryExclusionsTable)
    .where(and(eq(discoveryExclusionsTable.territoryId, territoryId), eq(discoveryExclusionsTable.active, true)));
  return new Set(rows.map((r) => r.domain));
}

/**
 * Pure, testable: is this (already-normalized) domain excluded for this
 * territory? Mirrors discoveryEngine.ts's own isExcludedDomain shape
 * (exact match or subdomain of an excluded domain) so both exclusion
 * mechanisms behave identically to a PAM/admin reading either list.
 */
export function isDomainExcluded(domain: string, exclusionDomains: ReadonlySet<string>): boolean {
  if (exclusionDomains.has(domain)) return true;
  for (const excluded of exclusionDomains) {
    if (domain.endsWith(`.${excluded}`)) return true;
  }
  return false;
}

export interface ExcludeCompanyInput {
  territoryId: string;
  /** Raw domain (e.g. from a company record) -- normalized internally via toRegistrableDomain, never trusted as pre-normalized. */
  domain: string;
  companyId?: string | null;
  reason: DiscoveryExclusionReason;
  note?: string | null;
  createdByUserId: string;
}

// "duplicate" is a valid reason to remove a single prospect ROW (handled
// entirely by the existing safe prospect delete), but must never reach this
// function -- excluding the domain would incorrectly block a legitimate
// canonical company from all future Discovery just because one duplicate
// record existed. Callers are expected to gate this themselves (see
// routes/prospects.ts), but this is enforced here too as the actual source
// of truth, not left as a frontend-only rule.
export async function excludeCompanyForTerritory(input: ExcludeCompanyInput, dbHandle: DbHandle = db) {
  if (!(DISCOVERY_EXCLUSION_REASONS as readonly string[]).includes(input.reason)) {
    throw new InvalidExclusionReasonError(`"${input.reason}" is not a valid exclusion reason.`);
  }
  const normalizedDomain = toRegistrableDomain(input.domain);
  if (!normalizedDomain) {
    throw new InvalidExclusionReasonError("Could not determine a domain to exclude for this company.");
  }

  // Idempotent: re-excluding an already-excluded domain updates the reason/
  // note rather than creating a second active row for the same territory+
  // domain -- avoids needing a partial unique index for what's a rare,
  // low-volume table.
  const [existingActive] = await dbHandle
    .select()
    .from(discoveryExclusionsTable)
    .where(
      and(
        eq(discoveryExclusionsTable.territoryId, input.territoryId),
        eq(discoveryExclusionsTable.domain, normalizedDomain),
        eq(discoveryExclusionsTable.active, true),
      ),
    );
  if (existingActive) {
    const [updated] = await dbHandle
      .update(discoveryExclusionsTable)
      .set({ reason: input.reason, note: input.note ?? existingActive.note, companyId: input.companyId ?? existingActive.companyId })
      .where(eq(discoveryExclusionsTable.id, existingActive.id))
      .returning();
    return updated!;
  }

  const [created] = await dbHandle
    .insert(discoveryExclusionsTable)
    .values({
      territoryId: input.territoryId,
      domain: normalizedDomain,
      companyId: input.companyId ?? null,
      reason: input.reason,
      note: input.note ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  return created!;
}

export async function restoreDiscoveryExclusion(id: string, restoredByUserId: string) {
  const [updated] = await db
    .update(discoveryExclusionsTable)
    .set({ active: false, restoredAt: new Date(), restoredByUserId })
    .where(and(eq(discoveryExclusionsTable.id, id), eq(discoveryExclusionsTable.active, true)))
    .returning();
  return updated ?? null;
}

// Shared select shape -- reused by both the active-only list (Settings view)
// and the single-row restore response (which must show a just-restored,
// now-inactive row).
function exclusionSelect() {
  return db
    .select({
      exclusion: discoveryExclusionsTable,
      territoryName: territoriesTable.name,
      companyName: companiesTable.name,
      createdByName: usersTable.name,
    })
    .from(discoveryExclusionsTable)
    .innerJoin(territoriesTable, eq(discoveryExclusionsTable.territoryId, territoriesTable.id))
    .leftJoin(companiesTable, eq(discoveryExclusionsTable.companyId, companiesTable.id))
    .leftJoin(usersTable, eq(discoveryExclusionsTable.createdByUserId, usersTable.id));
}

export async function listActiveDiscoveryExclusions() {
  return exclusionSelect().where(eq(discoveryExclusionsTable.active, true)).orderBy(discoveryExclusionsTable.createdAt);
}

export async function getDiscoveryExclusionById(id: string) {
  const [row] = await exclusionSelect().where(eq(discoveryExclusionsTable.id, id));
  return row ?? null;
}
