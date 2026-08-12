// Phase 4: focused authz/scoping tests for GET /prospects/activity/recent --
// the one genuinely new backend endpoint this stage added, powering the PAM
// Overview "Your Actions" recent-activity card. Same live-server-over-
// disposable-Postgres pattern as tests/roleSeparation.test.ts (which this
// deliberately does not duplicate -- assignment lifecycle, cross-PAM
// isolation, and Discovery->Recruitment semantics are already covered
// there and remain unchanged by this stage).
//
//   DATABASE_URL=... SEED_PASSWORD_IRINA=... SEED_PASSWORD_DENNY=... SEED_PASSWORD_JAMES=... \
//     BASE_URL=http://localhost:8080/api tsx --test tests/pamActionQueue.test.ts
// or `pnpm run test:pam-action-queue` with the same env exported and the
// dev server running.
//
// No Tavily/DeepSeek/HubSpot calls: fixtures come from POST /scans/run's
// demo-data fallback (no SEARCH_PROVIDER/AI_PROVIDER configured in the test
// env), asserted via data_status === "demo", same as roleSeparation.test.ts.
import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";

const CREDENTIALS = {
  irina: { email: "irina.dochitu@druidai.com", password: process.env.SEED_PASSWORD_IRINA, envVar: "SEED_PASSWORD_IRINA" }, // head_of_channels
  denny: { email: "denny.morais@druidai.com", password: process.env.SEED_PASSWORD_DENNY, envVar: "SEED_PASSWORD_DENNY" }, // PAM A -- Portugal, Canada and South America
  james: { email: "james.bradley@druidai.com", password: process.env.SEED_PASSWORD_JAMES, envVar: "SEED_PASSWORD_JAMES" }, // PAM B -- UK & Ireland
};

const missingEnvVars = Object.values(CREDENTIALS)
  .filter((c) => !c.password || c.password.trim() === "")
  .map((c) => c.envVar);
if (missingEnvVars.length > 0) {
  throw new Error(`Missing required seed password environment variable(s): ${missingEnvVars.join(", ")}.`);
}

const tokens: Record<string, string> = {};
let dennyId = "";
let dennyTerritoryId = "";
let scanConfigId = "";
let assignedProspectId = "";

async function login(email: string, password: string) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json() };
}
async function get(path: string, token?: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function patch(path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  for (const [key, cred] of Object.entries(CREDENTIALS)) {
    const { status, body } = await login(cred.email, cred.password);
    assert.equal(status, 200, `expected ${key} to log in, got ${status}: ${JSON.stringify(body)}`);
    tokens[key] = body.token;
  }

  dennyId = (await get("/auth/me", tokens.denny)).body.id;

  const territories = await get("/territories", tokens.irina);
  const dennyTerritory = territories.body.find((t: any) => t.name === "Portugal, Canada and South America");
  assert.ok(dennyTerritory, "expected seeded territory 'Portugal, Canada and South America' to exist");
  dennyTerritoryId = dennyTerritory.id;

  const configs = await get("/scan-configs", tokens.irina);
  const existingConfig = configs.body.find((c: any) => c.territory_id === dennyTerritoryId);
  if (existingConfig) {
    scanConfigId = existingConfig.id;
  } else {
    const created = await post("/scan-configs", tokens.irina, { territory_id: dennyTerritoryId });
    assert.equal(created.status, 201, `expected 201 creating scan config, got ${created.status}: ${JSON.stringify(created.body)}`);
    scanConfigId = created.body.id;
  }

  const scanRun = await post("/scans/run", tokens.irina, { scan_config_id: scanConfigId, mode: "mock" });
  assert.equal(scanRun.status, 200, `expected 200 running Discovery scan, got ${scanRun.status}: ${JSON.stringify(scanRun.body)}`);
  assert.equal(scanRun.body.data_status, "demo", "expected demo data_status -- this test env must not have live Search/AI providers configured");

  const created = await get(`/prospects?territory=${dennyTerritoryId}&status=new`, tokens.irina);
  const unassigned = created.body.filter((p: any) => p.assigned_user === null);
  assert.ok(unassigned.length >= 1, `expected at least 1 unassigned prospect from the scan, got ${unassigned.length}`);
  assignedProspectId = unassigned[0].id;

  const assign = await patch(`/prospects/${assignedProspectId}`, tokens.irina, { assigned_user_id: dennyId });
  assert.equal(assign.status, 200, `expected 200 assigning prospect to Denny, got ${assign.status}: ${JSON.stringify(assign.body)}`);
});

test("recent activity: PAM A's own decision on their assigned prospect appears in their own feed", async () => {
  const decision = await post(`/prospects/${assignedProspectId}/decision`, tokens.denny, { decision: "deferred", note: "phase 4 test" });
  assert.equal(decision.status, 200, `expected 200, got ${decision.status}: ${JSON.stringify(decision.body)}`);

  const feed = await get("/prospects/activity/recent?days=7", tokens.denny);
  assert.equal(feed.status, 200);
  assert.ok(
    feed.body.some((a: any) => a.prospect_id === assignedProspectId && a.event_type === "deferred"),
    "expected PAM A's own defer decision to appear in their own recent-activity feed",
  );
});

test("recent activity: PAM B never sees PAM A's activity, even though it happened within the window", async () => {
  const feed = await get("/prospects/activity/recent?days=7", tokens.james);
  assert.equal(feed.status, 200);
  assert.ok(
    !feed.body.some((a: any) => a.prospect_id === assignedProspectId),
    "PAM B's recent-activity feed must never include an activity entry for a prospect assigned to PAM A",
  );
});

test("recent activity: Head/Admin is not blocked and can see activity beyond a single PAM's scope", async () => {
  const feed = await get("/prospects/activity/recent?days=7", tokens.irina);
  assert.equal(feed.status, 200);
  assert.ok(
    feed.body.some((a: any) => a.prospect_id === assignedProspectId),
    "expected Head/Admin's unscoped feed to include the activity a PAM-scoped view already proved exists",
  );
});

test("recent activity: an out-of-window activity is excluded (days=0 returns nothing from a normal-timed test run)", async () => {
  const feed = await get("/prospects/activity/recent?days=0", tokens.denny);
  assert.equal(feed.status, 200);
  assert.ok(
    !feed.body.some((a: any) => a.prospect_id === assignedProspectId),
    "an activity from this test run must not appear when the window is narrowed to 0 days back",
  );
});

test("recent activity: unauthenticated request is rejected", async () => {
  const { status } = await get("/prospects/activity/recent");
  assert.equal(status, 401);
});
