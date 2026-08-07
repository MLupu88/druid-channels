import { createHmac, timingSafeEqual } from "node:crypto";

// Minimal signed-session tokens (HMAC-SHA256), used because this demo app
// has no password/login system yet -- only a client-side "act as this team
// member" switcher. Signing the token with a server-only secret means a
// caller can no longer manufacture a valid identity claim just by knowing a
// user's UUID (which is public via GET /users); they must go through
// POST /auth/session, and only the server can mint a token that
// requireAdmin will accept. This is a stopgap, not a full auth system: the
// session-mint endpoint does not check a password because none exists in
// this schema yet. If real login is added later, mint tokens only after
// verifying credentials there instead of trusting the caller's user_id.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set to issue or verify session tokens.");
  }
  return secret;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", getSecret()).update(payloadB64).digest("base64url");
}

export interface SessionPayload {
  sub: string; // user id
  iat: number; // issued-at, epoch ms
  exp: number; // expiry, epoch ms
}

export function issueSessionToken(userId: string): { token: string; expiresAt: Date } {
  const now = Date.now();
  const payload: SessionPayload = { sub: userId, iat: now, exp: now + SESSION_TTL_MS };
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = sign(payloadB64);
  return { token: `${payloadB64}.${signature}`, expiresAt: new Date(payload.exp) };
}

export function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;

  const expectedSignature = sign(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;

  return payload;
}
