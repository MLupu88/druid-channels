// Stage 6.1: single place that assigns territories.owner_user_id, reused by
// POST/PATCH /territories and POST/PATCH /users so the UI and the
// authorization model (services/authz.ts's getOwnTerritory, which reads
// this exact column) can never disagree. v1 invariant: one PAM owns one
// territory -- reassigning a PAM to a new territory auto-releases whatever
// they owned before; assigning an already-owned territory to someone else
// is always rejected, never silently overwritten.
import { db } from "@workspace/db";
import { territoriesTable, usersTable } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export class TerritoryAlreadyOwnedError extends Error {}
export class TerritoryNotFoundError extends Error {}

// Assigns `territoryId`'s ownership to `userId`. Must run inside the
// caller's own transaction when combined with other writes (e.g. creating
// the user row itself) so a failure never leaves a half-applied state.
export async function assignTerritoryOwner(executor: Executor, territoryId: string, userId: string): Promise<void> {
  const [target] = await executor.select().from(territoriesTable).where(eq(territoriesTable.id, territoryId));
  if (!target) throw new TerritoryNotFoundError("Territory not found");

  if (target.ownerUserId && target.ownerUserId !== userId) {
    const [currentOwner] = await executor.select().from(usersTable).where(eq(usersTable.id, target.ownerUserId));
    throw new TerritoryAlreadyOwnedError(
      `"${target.name}" is already owned by ${currentOwner?.name ?? "another PAM"}. Unassign it there first.`,
    );
  }

  // One PAM owns one territory: release any other territory this user
  // currently owns before granting the new one.
  await executor
    .update(territoriesTable)
    .set({ ownerUserId: null })
    .where(and(eq(territoriesTable.ownerUserId, userId), ne(territoriesTable.id, territoryId)));

  await executor.update(territoriesTable).set({ ownerUserId: userId }).where(eq(territoriesTable.id, territoryId));
}
