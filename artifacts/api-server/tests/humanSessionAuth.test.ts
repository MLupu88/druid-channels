// Pure unit tests for human session-token transport (middleware/auth.ts) and
// session-token verification (services/session.ts). No live DB, no live
// server: every case here is rejected (or extracted) before loadActingUser
// would query the users table. @workspace/db still throws at import time
// without DATABASE_URL, so run with the unreachable placeholder URL (see the
// test:human-session-auth script) -- no connection is ever opened.
//
// Roadmap 5C: human session tokens are accepted ONLY via
// Authorization: Bearer. A valid token in ?token= must never authenticate.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Request, RequestHandler, Response } from "express";
import { extractToken, requireAuth, requireAdmin, requirePam } from "../src/middleware/auth";
import { issueSessionToken, verifySessionToken } from "../src/services/session";

const ORIGINAL_SECRET = process.env.SESSION_SECRET;
const TEST_SECRET = "test-session-secret-5c-3f1d";

before(() => {
  process.env.SESSION_SECRET = TEST_SECRET;
});

after(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = ORIGINAL_SECRET;
});

function fakeRes() {
  const res = {
    statusCode: null as number | null,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res as unknown as Response;
    },
    json(payload: unknown) {
      res.body = payload;
      return res as unknown as Response;
    },
  };
  return res;
}

function fakeReq(overrides: { authorization?: string; query?: Record<string, unknown> } = {}) {
  return {
    headers: overrides.authorization ? { authorization: overrides.authorization } : {},
    query: overrides.query ?? {},
  } as unknown as Request;
}

async function invoke(handler: RequestHandler, req: Request, res: ReturnType<typeof fakeRes>) {
  let nextCalled = false;
  await handler(req, res as unknown as Response, (() => {
    nextCalled = true;
  }) as never);
  return nextCalled;
}

// Mirrors services/session.ts's token format so tests can mint tokens with
// arbitrary payloads (e.g. already expired) under the test secret.
function signToken(payload: object): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", TEST_SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

test("extractToken: returns the token from Authorization: Bearer", () => {
  assert.equal(extractToken(fakeReq({ authorization: "Bearer abc.def" })), "abc.def");
});

test("extractToken: the Bearer scheme is case-insensitive", () => {
  assert.equal(extractToken(fakeReq({ authorization: "bearer abc.def" })), "abc.def");
  assert.equal(extractToken(fakeReq({ authorization: "BEARER abc.def" })), "abc.def");
});

test("extractToken: a valid signed token supplied only as ?token= is ignored", () => {
  const { token } = issueSessionToken("user-1");
  assert.ok(verifySessionToken(token), "sanity: the token itself is valid");
  assert.equal(extractToken(fakeReq({ query: { token } })), null);
});

test("extractToken: with both a Bearer header and ?token=, only the header is used", () => {
  const header = issueSessionToken("header-user").token;
  const query = issueSessionToken("query-user").token;
  assert.equal(extractToken(fakeReq({ authorization: `Bearer ${header}`, query: { token: query } })), header);
});

test("extractToken: a non-Bearer Authorization header does not fall back to ?token=", () => {
  const { token } = issueSessionToken("user-1");
  assert.equal(extractToken(fakeReq({ authorization: `Basic ${token}`, query: { token } })), null);
});

for (const [name, handler] of [
  ["requireAuth", requireAuth],
  ["requireAdmin", requireAdmin],
  ["requirePam", requirePam],
] as const) {
  test(`${name}: a valid signed token supplied only as ?token= is rejected (401), next() not called, actingUser not set`, async () => {
    const { token } = issueSessionToken("user-1");
    const req = fakeReq({ query: { token } });
    const res = fakeRes();
    const nextCalled = await invoke(handler, req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
    assert.equal(req.actingUser, undefined);
  });
}

test("verifySessionToken: an expired session token is rejected", () => {
  const now = Date.now();
  const expired = signToken({ sub: "user-1", iat: now - 13 * 60 * 60 * 1000, exp: now - 1000 });
  assert.equal(verifySessionToken(expired), null);
});

test("verifySessionToken: a freshly issued token expires 12 hours after issue", () => {
  const { token, expiresAt } = issueSessionToken("user-1");
  const payload = verifySessionToken(token);
  assert.ok(payload);
  assert.equal(payload.exp - payload.iat, 12 * 60 * 60 * 1000);
  assert.equal(expiresAt.getTime(), payload.exp);
});

test("verifySessionToken: a tampered token is rejected", () => {
  const { token } = issueSessionToken("user-1");
  const [payloadB64, signature] = token.split(".");

  const forgedPayload = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")), sub: "someone-else" }),
  ).toString("base64url");
  assert.equal(verifySessionToken(`${forgedPayload}.${signature}`), null);

  const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
  assert.equal(verifySessionToken(`${payloadB64}.${flipped}`), null);
});

test("source guard: middleware/auth.ts does not read a session token from the query string", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "../src/middleware/auth.ts"), "utf8");
  assert.doesNotMatch(source, /query\s*\??\.\s*token\b/);
  assert.doesNotMatch(source, /query\s*\??\.?\s*\[\s*["'`]token["'`]\s*\]/);
});
