import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
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

const router: IRouter = Router();

function shapeUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    territory: u.territory,
    active: u.active,
  };
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
  const { name, territory, password } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "A user with this email already exists." });
    return;
  }

  try {
    const [created] = await db
      .insert(usersTable)
      .values({
        name,
        email,
        role: "pam",
        territory: territory ?? null,
        active: true,
        passwordHash: hashPassword(password),
      })
      .returning();

    res.status(201).json(CreateUserResponse.parse(shapeUser(created)));
  } catch (err: any) {
    // Guards the race between the existence check above and this insert
    // (two concurrent creates for the same email). Postgres unique
    // violation code: 23505.
    if (err?.code === "23505") {
      res.status(409).json({ error: "A user with this email already exists." });
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
  if (data.active !== undefined) updates.active = data.active;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }

  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();

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
