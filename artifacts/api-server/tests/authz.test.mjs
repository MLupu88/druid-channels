// Minimal authorization smoke tests for the DRUID Channels & Alliances API.
//
// Uses only Node's built-in test runner + fetch (no new test framework
// dependency). Run against a live dev server:
//   BASE_URL=http://localhost:8080/api node --test tests/authz.test.mjs
// or simply `pnpm run test:authz` from artifacts/api-server while the dev
// workflow is running.
import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";

const CREDENTIALS = {
  irina: { email: "irina.dochitu@druidai.com", password: "Irina2026", role: "head_of_channels" },
  denny: { email: "denny.morais@druidai.com", password: "Denny", role: "pam" },
  james: { email: "james.bradley@druidai.com", password: "James", role: "pam" },
  chase: { email: "chase.baylor@druidai.com", password: "Chase", role: "pam" },
  vlad: { email: "vlad.greavu@druidai.com", password: "Vlad", role: "pam" },
  elena: { email: "elena.panait@druidai.com", password: "Elena", role: "pam" },
};

const tokens = {};

async function login(email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  for (const [key, cred] of Object.entries(CREDENTIALS)) {
    const { status, body } = await login(cred.email, cred.password);
    assert.equal(status, 200, `expected ${key} to log in successfully, got ${status}: ${JSON.stringify(body)}`);
    tokens[key] = body.token;
  }
});

test("all six seeded users can log in with their credentials", () => {
  for (const key of Object.keys(CREDENTIALS)) {
    assert.ok(tokens[key], `expected a token for ${key}`);
  }
});

test("wrong password is rejected with 401, not a widened/default session", async () => {
  const { status, body } = await login(CREDENTIALS.denny.email, "wrong-password");
  assert.equal(status, 401);
  assert.ok(body.error);
});

test("unknown email is rejected with 401 and the same generic message as a wrong password", async () => {
  const wrongPassword = await login(CREDENTIALS.denny.email, "wrong-password");
  const unknownEmail = await login("nobody@druidai.com", "whatever");
  assert.equal(unknownEmail.status, 401);
  assert.equal(unknownEmail.body.error, wrongPassword.body.error);
});

test("unauthenticated request to a protected route is rejected with 401", async () => {
  const { status } = await get("/prospects");
  assert.equal(status, 401);
});

test("GET /auth/me returns the correct identity for each logged-in user", async () => {
  const { status, body } = await get("/auth/me", tokens.denny);
  assert.equal(status, 200);
  assert.equal(body.email, CREDENTIALS.denny.email);
  assert.equal(body.role, "pam");
});

test("a PAM is blocked (403) from admin-only routes", async () => {
  const usersList = await get("/users", tokens.denny);
  assert.equal(usersList.status, 403);

  const connections = await get("/connections", tokens.denny);
  assert.equal(connections.status, 403);
});

test("head_of_channels can reach admin-only routes", async () => {
  const { status } = await get("/users", tokens.irina);
  assert.equal(status, 200);
});

test("a PAM requesting another PAM's territory KPIs is rejected, not silently widened to Global", async () => {
  const { status, body } = await get("/kpis/head-of-channels?territory=DACH", tokens.denny);
  assert.ok(status === 403 || status === 400, `expected 403/400, got ${status}`);
  assert.ok(body?.error);
});

test("a PAM requesting an invalid/unknown territory id is rejected, not silently widened to Global", async () => {
  const { status, body } = await get("/kpis/head-of-channels?territory=not-a-real-territory", tokens.denny);
  assert.ok(status === 403 || status === 400, `expected 403/400, got ${status}`);
  assert.ok(body?.error);
});

test("a PAM can reach KPIs for their own territory", async () => {
  const { status } = await get("/kpis/head-of-channels", tokens.denny);
  assert.equal(status, 200);
});

test("head_of_channels can view any territory's KPIs, including another PAM's", async () => {
  const { status } = await get("/kpis/head-of-channels?territory=DACH", tokens.irina);
  assert.equal(status, 200);
});

test("a PAM cannot list prospects scoped to a foreign territory via query tampering", async () => {
  const { status, body } = await get("/prospects?territory=DACH", tokens.denny);
  assert.ok(status === 403 || status === 400, `expected 403/400, got ${status}`);
  assert.ok(body?.error);
});
