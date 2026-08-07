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
  irina: { email: "irina.dochitu@druidai.com", password: process.env.SEED_PASSWORD_IRINA, envVar: "SEED_PASSWORD_IRINA", role: "head_of_channels" },
  denny: { email: "denny.morais@druidai.com", password: process.env.SEED_PASSWORD_DENNY, envVar: "SEED_PASSWORD_DENNY", role: "pam" },
  james: { email: "james.bradley@druidai.com", password: process.env.SEED_PASSWORD_JAMES, envVar: "SEED_PASSWORD_JAMES", role: "pam" },
  chase: { email: "chase.baylor@druidai.com", password: process.env.SEED_PASSWORD_CHASE, envVar: "SEED_PASSWORD_CHASE", role: "pam" },
  vlad: { email: "vlad.greavu@druidai.com", password: process.env.SEED_PASSWORD_VLAD, envVar: "SEED_PASSWORD_VLAD", role: "pam" },
  elena: { email: "elena.panait@druidai.com", password: process.env.SEED_PASSWORD_ELENA, envVar: "SEED_PASSWORD_ELENA", role: "pam" },
};

// Fail fast, before any test runs, if a required seed password env var is
// missing. Mirrors the seed script's own contract (see
// artifacts/api-server/src/scripts/seed.ts) -- these tests authenticate as
// the same seeded accounts, so they need the same secrets. Never falls back
// to a hardcoded value and never logs the password itself, only the name of
// the missing variable.
const missingEnvVars = Object.values(CREDENTIALS)
  .filter((c) => !c.password || c.password.trim() === "")
  .map((c) => c.envVar);
if (missingEnvVars.length > 0) {
  throw new Error(
    `Missing required seed password environment variable(s): ${missingEnvVars.join(", ")}. ` +
      `Set these to the same values used when seeding the database.`,
  );
}

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

async function post(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function patch(path, token, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
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

test("head_of_channels can create a PAM", async () => {
  const email = `PAM-Test-${Date.now()}@DRUIDAI.COM`;
  const { status, body } = await post("/users", tokens.irina, {
    name: "Test PAM",
    email,
    territory: "DACH",
    password: "a-strong-temp-password-1",
  });
  assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.email, email.toLowerCase());
  assert.equal(body.name, "Test PAM");
  assert.equal(body.territory, "DACH");
  assert.equal(body.role, "pam");
  assert.equal(body.active, true);
});

test("a PAM cannot create users", async () => {
  const email = `PAM-Test-${Date.now()}@DRUIDAI.COM`;
  const { status, body } = await post("/users", tokens.denny, {
    name: "Should Not Be Created",
    email,
    territory: "DACH",
    password: "a-strong-temp-password-1",
  });
  assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(body?.error);
});

test("head_of_channels can change a PAM's territory", async () => {
  const email = `PAM-Test-${Date.now()}@DRUIDAI.COM`;
  const created = await post("/users", tokens.irina, {
    name: "Test PAM",
    email,
    territory: "DACH",
    password: "a-strong-temp-password-1",
  });
  assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
  const pamId = created.body.id;

  const { status, body } = await patch(`/users/${pamId}`, tokens.irina, {
    territory: "UK & Ireland",
  });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.id, pamId);
  assert.equal(body.territory, "UK & Ireland");
  assert.equal(body.role, "pam");
});

test("head_of_channels can deactivate a PAM", async () => {
  const email = `PAM-Test-${Date.now()}@DRUIDAI.COM`;
  const created = await post("/users", tokens.irina, {
    name: "Test PAM",
    email,
    territory: "DACH",
    password: "a-strong-temp-password-1",
  });
  assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
  const pamId = created.body.id;

  const { status, body } = await patch(`/users/${pamId}`, tokens.irina, {
    active: false,
  });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.id, pamId);
  assert.equal(body.active, false);
  assert.equal(body.role, "pam");
});

test("an inactive PAM cannot log in", async () => {
  const email = `PAM-Test-${Date.now()}@DRUIDAI.COM`;
  const password = "a-strong-temp-password-1";
  const created = await post("/users", tokens.irina, {
    name: "Test PAM",
    email,
    territory: "DACH",
    password,
  });
  assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
  const pamId = created.body.id;

  const deactivated = await patch(`/users/${pamId}`, tokens.irina, { active: false });
  assert.equal(deactivated.status, 200, `expected 200, got ${deactivated.status}: ${JSON.stringify(deactivated.body)}`);

  const { status, body } = await login(email, password);
  assert.equal(status, 401, `expected 401, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(body.error);
});

test("password reset invalidates the old password and the new temporary password works", async () => {
  const email = `PAM-Test-${Date.now()}@DRUIDAI.COM`;
  const originalPassword = "a-strong-temp-password-1";
  const created = await post("/users", tokens.irina, {
    name: "Test PAM",
    email,
    territory: "DACH",
    password: originalPassword,
  });
  assert.equal(created.status, 201, `expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
  const pamId = created.body.id;
  const loginEmail = created.body.email;

  const preReset = await login(loginEmail, originalPassword);
  assert.equal(preReset.status, 200, `expected 200, got ${preReset.status}: ${JSON.stringify(preReset.body)}`);

  const { status, body } = await post(`/users/${pamId}/reset-password`, tokens.irina);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.user.id, pamId);
  assert.equal(body.user.role, "pam");
  assert.equal(typeof body.temporary_password, "string");
  assert.ok(body.temporary_password.length >= 16);
  assert.notEqual(body.temporary_password, originalPassword);

  const oldLogin = await login(loginEmail, originalPassword);
  assert.equal(oldLogin.status, 401, `expected 401, got ${oldLogin.status}: ${JSON.stringify(oldLogin.body)}`);

  const newLogin = await login(loginEmail, body.temporary_password);
  assert.equal(newLogin.status, 200, `expected 200, got ${newLogin.status}: ${JSON.stringify(newLogin.body)}`);
});
