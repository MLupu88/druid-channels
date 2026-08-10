import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable, territoriesTable } from "@workspace/db";
import {
  ListUsersResponse,
  CreateUserBody,
  CreateUserResponse,
  UpdateUserBody,
  UpdateUserResponse,
  ResetUserPasswordResponse,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";
import { hashPassword, generateTemporaryPassword } from "../services/password";
import { assignTerritoryOwner, TerritoryAlreadyOwnedError, type Executor } from "../services/territoryOwnership";

const router: IRouter = Router();

function shapeUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    territory: u.territory,
    location_label: u.locationLabel,
    timezone: u.timezone,
    active: u.active,
  };
}

// Validated the standard way -- Intl throws RangeError on an unrecognized
// zone name -- rather than maintaining a separate static IANA zone list.
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

class TerritoryAssignmentInputError extends Error {}

// Resolves territory_id/new_territory_name into a canonical
// territories.owner_user_id assignment for `userId` (see
// services/territoryOwnership.ts for the one-PAM-one-territory invariant
// this enforces). Run inside the caller's own transaction. Returns the
// resolved territory's name (to sync onto users.territory, the display-only
// field) or undefined when neither field was provided -- i.e. no change.
async function resolveTerritoryAssignment(
  tx: Executor,
  userId: string,
  input: { territory_id?: string | null; new_territory_name?: string | null },
): Promise<string | undefined> {
  const territoryId = input.territory_id ?? null;
  const newTerritoryName = input.new_territory_name?.trim() || null;

  if (territoryId && newTerritoryName) {
    throw new TerritoryAssignmentInputError("Provide only one of territory_id or new_territory_name.");
  }

  if (newTerritoryName) {
    const [existingByName] = await tx.select().from(territoriesTable).where(eq(territoriesTable.name, newTerritoryName));
    if (existingByName) {
      throw new TerritoryAssignmentInputError(`A territory named "${newTerritoryName}" already exists.`);
    }
    const [created] = await tx.insert(territoriesTable).values({ name: newTerritoryName, countries: [], languages: [] }).returning();
    await assignTerritoryOwner(tx, created!.id, userId);
    return created!.name;
  }

  if (territoryId) {
    await assignTerritoryOwner(tx, territoryId, userId);
    const [territory] = await tx.select().from(territoriesTable).where(eq(territoriesTable.id, territoryId));
    return territory?.name;
  }

  return undefined;
}

// Team directory / roster: only head_of_channels/admin may list the full
// team (used by the Team admin tab and the PAMs directory page). A PAM's
// own identity comes from GET /auth/me, not this endpoint.
router.get("/users", requireAdmin, async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(usersTable.name);
  res.json(ListUsersResponse.parse(users.map(shapeUser)));
});

// Create a new PAM. Role is never taken from the request body -- it is
// always "pam" here, so this endpoint cannot be used to mint a
// head_of_channels/admin account, regardless of what a caller sends.
router.post("/users", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name, territory, password, territory_id, new_territory_name } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();

  if (parsed.data.timezone && !isValidIanaTimezone(parsed.data.timezone)) {
    res.status(400).json({ error: `"${parsed.data.timezone}" is not a valid IANA timezone.` });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "A user with this email already exists." });
    return;
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [insertedUser] = await tx
        .insert(usersTable)
        .values({
          name,
          email,
          role: "pam",
          territory: territory ?? null,
          locationLabel: parsed.data.location_label ?? null,
          timezone: parsed.data.timezone ?? null,
          active: true,
          passwordHash: hashPassword(password),
        })
        .returning();

      const resolvedTerritoryName = await resolveTerritoryAssignment(tx, insertedUser!.id, { territory_id, new_territory_name });
      if (resolvedTerritoryName === undefined) return insertedUser!;

      const [updated] = await tx.update(usersTable).set({ territory: resolvedTerritoryName }).where(eq(usersTable.id, insertedUser!.id)).returning();
      return updated!;
    });

    res.status(201).json(CreateUserResponse.parse(shapeUser(created)));
  } catch (err: any) {
    // Guards the race between the existence check above and the insert
    // (two concurrent creates for the same email). Postgres unique
    // violation code: 23505.
    if (err?.code === "23505") {
      res.status(409).json({ error: "A user with this email already exists." });
      return;
    }
    if (err instanceof TerritoryAlreadyOwnedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof TerritoryAssignmentInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// Team administration only ever targets a PAM: Irina/other admins are never
// editable through this endpoint. UserEditInput no longer accepts a role
// field at all, so a role change is rejected by schema validation before
// this handler ever runs.
router.patch("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.timezone && !isValidIanaTimezone(parsed.data.timezone)) {
    res.status(400).json({ error: `"${parsed.data.timezone}" is not a valid IANA timezone.` });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (existing.role !== "pam") {
    res.status(400).json({ error: "Target user is not a PAM" });
    return;
  }

  const data = parsed.data;
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.territory !== undefined) updates.territory = data.territory;
  if (data.location_label !== undefined) updates.locationLabel = data.location_label;
  if (data.timezone !== undefined) updates.timezone = data.timezone;
  if (data.active !== undefined) updates.active = data.active;

  const hasTerritoryAssignment = data.territory_id !== undefined || data.new_territory_name !== undefined;
  if (Object.keys(updates).length === 0 && !hasTerritoryAssignment) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }

  let updated: typeof usersTable.$inferSelect;
  try {
    updated = await db.transaction(async (tx) => {
      if (hasTerritoryAssignment) {
        const resolvedTerritoryName = await resolveTerritoryAssignment(tx, id, {
          territory_id: data.territory_id,
          new_territory_name: data.new_territory_name,
        });
        if (resolvedTerritoryName !== undefined) updates.territory = resolvedTerritoryName;
      }
      if (Object.keys(updates).length === 0) {
        const [row] = await tx.select().from(usersTable).where(eq(usersTable.id, id));
        return row!;
      }
      const [row] = await tx.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
      return row!;
    });
  } catch (err) {
    if (err instanceof TerritoryAlreadyOwnedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof TerritoryAssignmentInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json(UpdateUserResponse.parse(shapeUser(updated)));
});

// Reset access for a PAM: generates a new strong temporary password
// server-side, hashes it with the same scrypt mechanism used everywhere else,
// and immediately overwrites the stored hash so the old password stops
// working. The plaintext is returned exactly once in this response and is
// never logged or persisted. Scoped to PAM targets only -- resetting a
// head_of_channels/admin's own credential is out of scope for this
// PAM-management action (enforced here, not just hidden in the UI).
router.post("/users/:id/reset-password", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (existing.role !== "pam") {
    res.status(400).json({ error: "Target user is not a PAM" });
    return;
  }

  const temporaryPassword = generateTemporaryPassword();
  const [updated] = await db
    .update(usersTable)
    .set({ passwordHash: hashPassword(temporaryPassword) })
    .where(eq(usersTable.id, id))
    .returning();

  res.json(ResetUserPasswordResponse.parse({ user: shapeUser(updated), temporary_password: temporaryPassword }));
});

export default router;
