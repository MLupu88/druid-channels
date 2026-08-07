import { createHmac, timingSafeEqual } from "node:crypto";

// Minimal signed-session tokens (HMAC-SHA256), issued only after a real
// password check in POST /auth/login (see routes/auth.ts and
// services/password.ts). Signing with a server-only secret means a caller
// cannot manufacture a valid identity claim without first proving they know
// a user's password. Tokens are stateless (no server-side session store),
// so "logout" simply asks the client to discard the token; a compromised
// token remains valid until it expires (see SESSION_TTL_MS below).
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
