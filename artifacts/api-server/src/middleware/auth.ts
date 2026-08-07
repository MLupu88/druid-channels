import type { Request, RequestHandler } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifySessionToken } from "../services/session";

// This app has no password login -- the frontend lets a demo user "act as"
// one of a small set of seeded team members (see UserProvider), which mints
// a signed session token via POST /auth/session. That signature is the
// security boundary here: admin-only write endpoints (connections, metric
// mappings, manual KPI values) require an `Authorization: Bearer <token>`
// header containing a token *this server* signed with SESSION_SECRET, not a
// bare user id. A caller cannot forge a token without the secret, so raw
// UUIDs harvested from GET /users are useless on their own. The referenced
// user's role is re-checked fresh from the DB on every request (not trusted
// from the token) so a role change or deactivation takes effect immediately.
const ADMIN_ROLES = new Set(["head_of_channels", "admin"]);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actingUser?: typeof usersTable.$inferSelect;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const token = extractToken(req as Request);
  if (!token) {
    res.status(401).json({ error: "Authentication required. Send Authorization: Bearer <session token>." });
    return;
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired session token." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payload.sub));
  if (!user || !user.active) {
    res.status(401).json({ error: "Unknown or inactive user." });
    return;
  }

  if (!ADMIN_ROLES.has(user.role)) {
    res.status(403).json({ error: "This action requires an admin or head-of-channels role." });
    return;
  }

  req.actingUser = user;
  next();
}
