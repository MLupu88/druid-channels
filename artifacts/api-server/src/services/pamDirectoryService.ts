// Phase 12 Aniri PAM-level intelligence: the controlled, read-only factual
// boundary for GET /channel-chief/pam-directory (routes/channel_chief.ts).
// Deliberately the smallest possible module -- a canonical PAM roster is
// identity/ownership data, not a computation, so unlike
// channelChiefContextService.ts/pamOverviewService.ts there is no business
// rule to reuse here (only the shared PamTerritory shape from
// pamOverviewService, so both contracts represent ownership identically).
// No performance, portfolio, or pipeline data belongs in this file; that is what
// get_pam_overview is for once a caller already has a name to resolve. This
// module exists for the opposite direction: "who are the PAMs / who owns
// territory X," which neither get_channel_snapshot (no PAM identity at all)
// nor get_pam_overview (requires a name up front) can answer.
import { db, usersTable, territoriesTable, type User } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { toPamTerritory, type PamTerritory } from "./pamOverviewService";

export interface PamDirectoryEntry {
  pam_user_id: string;
  pam_name: string;
  pam_email: string;
  // Every territory this PAM canonically owns (territories.owner_user_id),
  // ordered by name then id -- same representation as pamOverviewService's
  // identity.territories. Empty, never invented, when they own none.
  territories: PamTerritory[];
  active: boolean;
}

function shapeEntry(pam: User, territories: PamTerritory[]): PamDirectoryEntry {
  return {
    pam_user_id: pam.id,
    pam_name: pam.name,
    pam_email: pam.email,
    territories,
    active: pam.active,
  };
}

// Active PAMs only, ordered deterministically by name then id (a plain
// .orderBy(name) tie among two same-named PAMs is otherwise unordered in
// Postgres) -- matches the sort convention channelChiefContextService's own
// comparators use elsewhere in this API. territories.owner_user_id carries
// no DB-level uniqueness constraint, so a PAM may own several territories;
// every one is listed (never just the first) rather than silently dropping
// ownership or duplicating the PAM row.
export async function getPamDirectory(): Promise<PamDirectoryEntry[]> {
  const [pams, territories] = await Promise.all([
    db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.role, "pam"), eq(usersTable.active, true)))
      .orderBy(asc(usersTable.name), asc(usersTable.id)),
    db.select().from(territoriesTable).orderBy(asc(territoriesTable.name), asc(territoriesTable.id)),
  ]);

  const territoriesByOwnerUserId = new Map<string, PamTerritory[]>();
  for (const territory of territories) {
    if (!territory.ownerUserId) continue;
    const owned = territoriesByOwnerUserId.get(territory.ownerUserId) ?? [];
    owned.push(toPamTerritory(territory));
    territoriesByOwnerUserId.set(territory.ownerUserId, owned);
  }

  return pams.map((pam) => shapeEntry(pam, territoriesByOwnerUserId.get(pam.id) ?? []));
}
