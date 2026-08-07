import type { Request, RequestHandler } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifySessionToken } from "../services/session";

// Real authentication: a session token is only ever minted by
// POST /auth/login after a password check (see routes/auth.ts). Every
// protected route re-reads the user's role fresh from the DB on each
// request (never trusted from the token payload), so a role change or
// deactivation takes effect immediately without needing to reissue tokens.
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
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match) return match[1].trim();
  }
  // Downloads triggered via window.open()/<a href> (e.g. the quarterly PPTX
  // export) can't attach an Authorization header, so also accept the token
  // as a query parameter on those GET requests.
  const queryToken = req.query?.token;
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();
  return null;
}

async function loadActingUser(req: Request): Promise<typeof usersTable.$inferSelect | null> {
  const token = extractToken(req);
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payload.sub));
  if (!user || !user.active) return null;
  return user;
}

/** Requires any valid, active-user session. Populates req.actingUser. */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const user = await loadActingUser(req as Request);
  if (!user) {
    res.status(401).json({ error: "Authentication required. Send Authorization: Bearer <session token>." });
    return;
  }
  req.actingUser = user;
  next();
};

/** Requires an active session AND a head_of_channels/admin role. */
export const requireAdmin: RequestHandler = async (req, res, next) => {
  const user = await loadActingUser(req as Request);
  if (!user) {
    res.status(401).json({ error: "Authentication required. Send Authorization: Bearer <session token>." });
    return;
  }
  if (!ADMIN_ROLES.has(user.role)) {
    res.status(403).json({ error: "This action requires an admin or head-of-channels role." });
    return;
  }
  req.actingUser = user;
  next();
};
