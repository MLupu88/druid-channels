import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";

// Machine-to-machine auth for the Aniri/Channel Chief endpoints. Deliberately
// separate from middleware/auth.ts's human requireAuth/requireAdmin: this
// never reads a session token, never queries the users table, and never
// populates req.actingUser -- there is no human identity behind this
// request, only a trusted caller holding a shared service token. The token
// is only ever accepted via Authorization: Bearer (never a query string, so
// it can't leak into logs/proxies/browser history the way the PPTX export's
// query-param token intentionally can -- see middleware/auth.ts's
// extractToken comment for that different, human-download-triggered case).
function tokensMatch(provided: string, configured: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/** Requires Authorization: Bearer <CHANNEL_CHIEF_API_TOKEN>. Fails closed if unconfigured. */
export const requireChannelChiefToken: RequestHandler = (req, res, next) => {
  const configuredToken = process.env.CHANNEL_CHIEF_API_TOKEN;
  if (!configuredToken) {
    res.status(401).json({ error: "The Channel Chief API is not configured." });
    return;
  }

  const providedToken = extractBearerToken(req.headers.authorization);
  if (!providedToken || !tokensMatch(providedToken, configuredToken)) {
    res.status(401).json({ error: "Invalid or missing service token. Send Authorization: Bearer <token>." });
    return;
  }

  next();
};
