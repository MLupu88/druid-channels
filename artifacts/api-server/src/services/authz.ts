import { db } from "@workspace/db";
import { territoriesTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveTerritory, type ResolvedTerritory } from "./kpiService";

export type ActingUser = typeof usersTable.$inferSelect;

export const GLOBAL_ROLES = new Set(["head_of_channels", "admin"]);

export function isGlobalUser(user: ActingUser): boolean {
  return GLOBAL_ROLES.has(user.role);
}

export class ForbiddenScopeError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Returns the territory a PAM owns (via territories.owner_user_id), or null
 * if none is configured. This is the single source of truth for "own
 * territory" -- never the free-text users.territory display field, which
 * is not guaranteed to match a territories.name row.
 */
export async function getOwnTerritory(userId: string): Promise<ResolvedTerritory | null> {
  const [row] = await db.select().from(territoriesTable).where(eq(territoriesTable.ownerUserId, userId));
  if (!row) return null;
  return { territoryId: row.id, territoryName: row.name };
}

// Phase 7: a PAM MAY canonically own more than one territory --
// territories.owner_user_id has no DB uniqueness constraint, unlike the
// single-territory assumption every other existing feature relies on via
// getOwnTerritory above. Weekly reporting must reflect a PAM's FULL owned
// set rather than silently picking one (see services/weeklyReportingService.ts).
// Additive: getOwnTerritory's single-result behavior and every existing
// caller of it are unchanged.
export interface OwnedTerritories {
  territoryIds: string[];
  territoryNames: string[];
}

export async function getOwnTerritories(userId: string): Promise<OwnedTerritories | null> {
  const rows = await db.select().from(territoriesTable).where(eq(territoriesTable.ownerUserId, userId));
  if (rows.length === 0) return null;
  return { territoryIds: rows.map((r) => r.id), territoryNames: rows.map((r) => r.name) };
}

/**
 * Resolves the effective territory scope for a request, given the acting
 * (session-derived) user and an optional client-requested territory
 * (name or id, or undefined/"global" for Global).
 *
 * - head_of_channels / admin: trusted to request any territory, including
 *   Global -- same behavior as before authentication existed.
 * - pam: can only ever see their own territory. If they omit the
 *   parameter, it defaults to their own territory (never Global). If they
 *   pass anything else (their own name is fine, but Global or another
 *   territory is not), this throws ForbiddenScopeError instead of silently
 *   widening to Global -- an invalid or foreign request must fail loudly.
 */
export async function resolveScopedTerritory(
  actingUser: ActingUser,
  requestedTerritory: string | undefined | null,
): Promise<ResolvedTerritory> {
  if (isGlobalUser(actingUser)) {
    return resolveTerritory(requestedTerritory);
  }

  const own = await getOwnTerritory(actingUser.id);
  if (!own) {
    throw new ForbiddenScopeError("Your account has no territory assigned. Contact an admin.");
  }

  const isUnset = !requestedTerritory || ["global", "Global", "null", "undefined"].includes(requestedTerritory);
  if (isUnset) return own;

  if (requestedTerritory === own.territoryId || requestedTerritory === own.territoryName) {
    return own;
  }

  throw new ForbiddenScopeError("You do not have access to that territory.");
}

/**
 * Guards a territory id/name that appears on a specific record (e.g. a
 * prospect, campaign, or scan config) the caller is trying to read or
 * mutate. Head-of-channels/admin always pass. A PAM passes only if the
 * record's territory matches their own.
 */
export async function assertRecordTerritoryAccess(
  actingUser: ActingUser,
  recordTerritoryId: string | null | undefined,
  recordTerritoryName: string | null | undefined,
): Promise<void> {
  if (isGlobalUser(actingUser)) return;
  const own = await getOwnTerritory(actingUser.id);
  if (!own) throw new ForbiddenScopeError("Your account has no territory assigned. Contact an admin.");
  const matches =
    (recordTerritoryId && recordTerritoryId === own.territoryId) ||
    (recordTerritoryName && recordTerritoryName === own.territoryName);
  if (!matches) throw new ForbiddenScopeError("You do not have access to this record.");
}

/**
 * Guards ownership of a record keyed directly to a user (e.g. a campaign's
 * owner_user_id, or a prospect's assigned_user_id). Head-of-channels/admin
 * always pass. A PAM passes only if the record belongs to them.
 */
export function assertOwnUserAccess(actingUser: ActingUser, recordUserId: string | null | undefined): void {
  if (isGlobalUser(actingUser)) return;
  if (recordUserId !== actingUser.id) {
    throw new ForbiddenScopeError("You do not have access to this record.");
  }
}
