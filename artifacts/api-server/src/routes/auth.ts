import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { LoginBody as LoginInput, LoginResponse as AuthLoginResponse, LogoutResponse as AuthLogoutResponse, GetCurrentUserResponse as User } from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { issueSessionToken } from "../services/session";
import { verifyPassword } from "../services/password";
import { requireAuth } from "../middleware/auth";

const router: IRouter = Router();

function shapeUser(u: typeof usersTable.$inferSelect) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, territory: u.territory, active: u.active };
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { email, password } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.trim().toLowerCase()));

  // Same error for "no such user" and "wrong password" -- do not reveal
  // which one it was.
  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }

  const { token, expiresAt } = issueSessionToken(user.id);
  res.json(AuthLoginResponse.parse({
    token,
    user: shapeUser(user),
    expires_at: expiresAt.toISOString(),
  }));
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  res.json(User.parse(shapeUser(req.actingUser!)));
});

// Session tokens are stateless (signed, not stored server-side), so there
// is nothing to revoke here; the client is expected to discard the token.
// This endpoint exists so the frontend has a single, honest logout call
// instead of quietly deleting local storage. If server-side revocation is
// ever needed, add a token-denylist table and check it in requireAuth.
router.post("/auth/logout", async (_req, res): Promise<void> => {
  res.json(AuthLogoutResponse.parse({ success: true }));
});

export default router;
