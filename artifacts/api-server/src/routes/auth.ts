import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { CreateAuthSessionBody, CreateAuthSessionResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { issueSessionToken } from "../services/session";

const router: IRouter = Router();

// Issues a signed session token for the "act as this team member" switcher.
// There is no password in this schema yet, so this does not verify a
// credential -- it only ensures every subsequent protected request carries
// a token the *server* minted (and can verify with SESSION_SECRET) instead
// of a bare, publicly-known user id. See services/session.ts for the
// security rationale and services/session.ts docstring for follow-up work
// once real login exists.
router.post("/auth/session", async (req, res): Promise<void> => {
  const body = CreateAuthSessionBody.parse(req.body);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, body.user_id));
  if (!user || !user.active) {
    res.status(404).json({ error: "Unknown or inactive user." });
    return;
  }

  const { token, expiresAt } = issueSessionToken(user.id);
  res.json(CreateAuthSessionResponse.parse({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, territory: user.territory, active: user.active },
    expires_at: expiresAt.toISOString(),
  }));
});

export default router;
