import type { RequestHandler } from "express";
import cors, { type CorsOptions } from "cors";

// HTTP boundary hardening for the API: an explicit CORS policy plus a small
// set of baseline response headers. Deliberately hand-rolled (no Helmet) so
// every header we emit is one we have checked the app can support.
//
// CORS is NOT authentication or authorization. A disallowed browser Origin
// never turns a request into a 401/403 -- it just gets no
// Access-Control-Allow-Origin, so the browser withholds the response from
// the calling page. Requests with no Origin (same-origin navigations,
// server-to-server callers such as Channel Chief / Aniri, curl) are never
// affected. Auth stays Bearer-only in middleware/auth.ts and
// middleware/channelChiefAuth.ts.

export const CORS_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const CORS_ALLOWED_HEADERS = ["Authorization", "Content-Type", "Accept"] as const;

/** Parses CORS_ALLOWED_ORIGIN: comma-separated, whitespace-trimmed, empties dropped. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}

/**
 * - allowlist configured          -> only an exactly matching Origin is echoed back
 * - no allowlist, production      -> no Origin is ever granted (empty allowlist)
 * - no allowlist, not production  -> permissive `*`, so a dev frontend on a
 *                                    different port keeps working
 * Credentials are never allowed: auth is a Bearer header, not a cookie.
 */
export function buildCorsOptions(env: NodeJS.ProcessEnv): CorsOptions {
  const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGIN);
  let origin: CorsOptions["origin"];
  if (allowedOrigins.length > 0) origin = allowedOrigins;
  else if (env.NODE_ENV === "production") origin = [];
  else origin = "*";

  return {
    origin,
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    credentials: false,
  };
}

export function createCorsMiddleware(env: NodeJS.ProcessEnv): RequestHandler {
  return cors(buildCorsOptions(env));
}

// The API only ever returns JSON or file attachments (PPTX), never HTML, so
// a deny-everything CSP is safe here and has no effect on the SPA. Headers
// set per-route (e.g. the PPTX Content-Type/Content-Disposition) are
// untouched.
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export const apiSecurityHeaders: RequestHandler = (_req, res, next) => {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  next();
};
