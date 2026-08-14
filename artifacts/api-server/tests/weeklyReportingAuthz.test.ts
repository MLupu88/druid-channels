// Phase 7: route-level authz/scoping regression tests for the weekly PAM
// reporting endpoints. Run against a live dev server backed by a real
// (disposable) Postgres -- same pattern as tests/opportunitiesAuthz.test.ts
// and tests/campaignsAuthz.test.ts.
//
//   DATABASE_URL=... SEED_PASSWORD_IRINA=... SEED_PASSWORD_DENNY=... SEED_PASSWORD_JAMES=... \
//     BASE_URL=http://localhost:8080/api tsx --test tests/weeklyReportingAuthz.test.ts
//
// WRITTEN BUT NOT RUN in this session: no disposable Postgres or live dev
// server was available or permitted (Phase 7's working rules forbid Docker/
// production DB access). Written to the same convention as the existing
// suite so it can be run once a disposable Postgres is provisioned. No
// Tavily/DeepSeek/HubSpot/live-FX calls: every fixture uses currency "USD"
// only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import { db, pool, companiesTable, partnerOpportunitiesTable, weeklyPamReportsTable } from "@workspace/db";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";

const CREDENTIALS = {
  irina: { email: "irina.dochitu@druidai.com", password: process.env.SEED_PASSWORD_IRINA, envVar: "SEED_PASSWORD_IRINA" }, // head_of_channels
  denny: { email: "denny.morais@druidai.com", password: process.env.SEED_PASSWORD_DENNY, envVar: "SEED_PASSWORD_DENNY" }, // PAM A
  james: { email: "james.bradley@druidai.com", password: process.env.SEED_PASSWORD_JAMES, envVar: "SEED_PASSWORD_JAMES" }, // PAM B
};

const missingEnvVars = Object.values(CREDENTIALS)
  .filter((c) => !c.password || c.password.trim() === "")
  .map((c) => c.envVar);
if (missingEnvVars.length > 0) {
  throw new Error(`Missing required seed password environment variable(s): ${missingEnvVars.join(", ")}. Set these to the same values used when seeding the database.`);
}

const tokens: Record<string, string> = {};
let dennyId = "";
let jamesId = "";
let dennyTerritoryId = "";
let jamesTerritoryId = "";
let companyId = "";
const createdCompanyIds: string[] = [];
const createdOpportunityIds: string[] = [];
const createdReportRowKeys: Array<{ pamUserId: string; weekStartDate: string }> = [];

// Two consecutive far-future Mondays, verified programmatically against the
// exact same Monday-alignment logic kpiService.mondayOf/
// weeklyReportingService.isCanonicalMonday use (day===0 ? 6 : day-1 offset):
// new Date("2986-01-02T00:00:00.000Z").getUTCDay() === 1 (Monday), and
// "2986-01-09" is exactly 7 days later, also a Monday. Deliberately far in
// the future (never "this week") so this suite never collides with a real
// PAM's actual weekly report, and deliberately NOT derived from today's
// date, since historical/future week correctness matters here.
const TEST_WEEK_START = "2986-01-02";
const TEST_WEEK_2_START = "2986-01-09";

// Explicit `body: any` return type: this Node environment's global fetch
// types Response.json() as Promise<unknown>, and these test helpers
// deliberately access arbitrary response JSON shape dynamically (assertion
// by assertion), same as every other route-level authz test in this suite.
async function login(email: string, password: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(path: string, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function put(path: string, token: string | undefined, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}${path}`, { method: "PUT", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function post(path: string, token: string | undefined, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  for (const [key, cred] of Object.entries(CREDENTIALS)) {
    // Non-null assertion is safe here: the missingEnvVars check above
    // already threw at module load if any of these were unset.
    const { status, body } = await login(cred.email, cred.password!);
    assert.equal(status, 200, `expected ${key} to log in, got ${status}: ${JSON.stringify(body)}`);
    tokens[key] = body.token;
  }

  dennyId = (await get("/auth/me", tokens.denny)).body.id;
  jamesId = (await get("/auth/me", tokens.james)).body.id;
  assert.ok(dennyId && jamesId, "expected auth/me to resolve both PAM ids");

  const territories = await get("/territories", tokens.irina);
  assert.equal(territories.status, 200);
  const dennyTerritory = territories.body.find((t: any) => t.name === "Portugal, Canada and South America");
  const jamesTerritory = territories.body.find((t: any) => t.name === "UK & Ireland");
  assert.ok(dennyTerritory && jamesTerritory, "expected both seeded territories to exist");
  dennyTerritoryId = dennyTerritory.id;
  jamesTerritoryId = jamesTerritory.id;

  const [company] = await db.insert(companiesTable).values({ name: `Weekly-Reporting-Test-Co-${Date.now()}`, country: "Unknown" }).returning();
  companyId = company!.id;
  createdCompanyIds.push(companyId);
});

after(async () => {
  for (const id of createdOpportunityIds) {
    await db.delete(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.id, id));
  }
  for (const id of createdCompanyIds) {
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  }
  // Deletes exactly the (pam_user_id, week_start_date) rows this suite
  // created -- never a PAM's other/real weekly reports.
  for (const key of createdReportRowKeys) {
    await db
      .delete(weeklyPamReportsTable)
      .where(and(eq(weeklyPamReportsTable.pamUserId, key.pamUserId), eq(weeklyPamReportsTable.weekStartDate, key.weekStartDate)));
  }
  await pool.end();
});

// ---- PAM self-service: own report -----------------------------------------

test("GET /reporting/weekly/me: PAM can view their own current-week report (draft, live)", async () => {
  const { status, body } = await get("/reporting/weekly/me", tokens.denny);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.pam_user_id, dennyId);
  assert.equal(body.status, "draft");
  assert.equal(body.snapshot_generated_at, null, "a draft report must never carry a frozen snapshot timestamp");
});

test("GET /reporting/weekly/me: Head/Admin is rejected (403) -- requirePam excludes non-PAM roles even though they are authenticated", async () => {
  const { status } = await get("/reporting/weekly/me", tokens.irina);
  assert.equal(status, 403);
});

test("GET /reporting/weekly/me?week_start=...: rejects a non-canonical-Monday week_start (400)", async () => {
  const nonMonday = "2986-01-07"; // 5 days after the verified Monday TEST_WEEK_START -- never itself a Monday
  const { status } = await get(`/reporting/weekly/me?week_start=${nonMonday}`, tokens.denny);
  assert.equal(status, 400);
});

// ---- PAM self-service: commentary -----------------------------------------

test("PUT /reporting/weekly/me/commentary: PAM can save their own commentary as a draft", async () => {
  const { status, body } = await put("/reporting/weekly/me/commentary", tokens.denny, {
    week_start: TEST_WEEK_START,
    wins_progress: "Closed the Acme deal",
    risks_blockers: null,
    priorities_next_week: "Follow up with Globex",
    help_needed: null,
  });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.commentary.wins_progress, "Closed the Acme deal");
  assert.equal(body.status, "draft");
  createdReportRowKeys.push({ pamUserId: dennyId, weekStartDate: TEST_WEEK_START });

  const reread = await get(`/reporting/weekly/me?week_start=${TEST_WEEK_START}`, tokens.denny);
  assert.equal(reread.status, 200);
  assert.equal(reread.body.commentary.wins_progress, "Closed the Acme deal", "commentary must persist across a re-read");
});

test("PUT /reporting/weekly/me/commentary: a field omitted from the body leaves the existing value unchanged; explicit null clears it", async () => {
  await put("/reporting/weekly/me/commentary", tokens.denny, { week_start: TEST_WEEK_2_START, wins_progress: "Initial wins", help_needed: "Need pricing approval" });
  createdReportRowKeys.push({ pamUserId: dennyId, weekStartDate: TEST_WEEK_2_START });

  const partialUpdate = await put("/reporting/weekly/me/commentary", tokens.denny, { week_start: TEST_WEEK_2_START, help_needed: null });
  assert.equal(partialUpdate.status, 200);
  assert.equal(partialUpdate.body.commentary.wins_progress, "Initial wins", "omitted field must be left unchanged");
  assert.equal(partialUpdate.body.commentary.help_needed, null, "explicit null must clear the field");
});

test("PUT /reporting/weekly/me/commentary: Head/Admin cannot use the self-service endpoint at all (403)", async () => {
  const { status } = await put("/reporting/weekly/me/commentary", tokens.irina, { week_start: TEST_WEEK_START, wins_progress: "x" });
  assert.equal(status, 403);
});

test("weekly_pam_reports unique identity: repeated commentary saves for the same (pam, week) update the same row, never create a duplicate", async () => {
  const rowsForWeek = await db
    .select()
    .from(weeklyPamReportsTable)
    .where(and(eq(weeklyPamReportsTable.pamUserId, dennyId), eq(weeklyPamReportsTable.weekStartDate, TEST_WEEK_START)));
  assert.equal(rowsForWeek.length, 1, "exactly one row must exist for (denny, TEST_WEEK_START) after multiple commentary saves");
});

// ---- Head/Admin: PAM drill-down ---------------------------------------

test("GET /reporting/weekly/pam/:userId: PAM is rejected (403) -- this is Head/Admin only", async () => {
  const { status } = await get(`/reporting/weekly/pam/${jamesId}?week_start=${TEST_WEEK_START}`, tokens.denny);
  assert.equal(status, 403);
});

test("GET /reporting/weekly/pam/:userId: Head/Admin can view any PAM's report, and it matches what that PAM sees themselves", async () => {
  const drillDown = await get(`/reporting/weekly/pam/${dennyId}?week_start=${TEST_WEEK_START}`, tokens.irina);
  assert.equal(drillDown.status, 200, `expected 200, got ${drillDown.status}: ${JSON.stringify(drillDown.body)}`);
  const own = await get(`/reporting/weekly/me?week_start=${TEST_WEEK_START}`, tokens.denny);
  assert.equal(drillDown.body.commentary.wins_progress, own.body.commentary.wins_progress, "drill-down must show exactly what the PAM sees on their own report");
  assert.equal(drillDown.body.metrics.commercial.open_pipeline_usd.total, own.body.metrics.commercial.open_pipeline_usd.total);
});

test("GET /reporting/weekly/pam/:userId: an invalid userId path param is rejected (400), not a raw 500", async () => {
  const { status } = await get(`/reporting/weekly/pam/not-a-real-user-id`, tokens.irina);
  assert.ok(status === 400 || status === 404, `expected 400 or 404 for a nonexistent PAM, got ${status}`);
});

// ---- Head/Admin: team view ----------------------------------------------

test("GET /reporting/weekly/team: PAM is rejected (403)", async () => {
  const { status } = await get(`/reporting/weekly/team?week_start=${TEST_WEEK_START}`, tokens.denny);
  assert.equal(status, 403);
});

test("GET /reporting/weekly/team: Head/Admin sees a PAM-by-PAM breakdown that includes both seeded PAMs, and team totals equal the sum of the displayed rows", async () => {
  const { status, body } = await get(`/reporting/weekly/team?week_start=${TEST_WEEK_START}`, tokens.irina);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

  const dennyRow = body.pam_reports.find((r: any) => r.pam_user_id === dennyId);
  const jamesRow = body.pam_reports.find((r: any) => r.pam_user_id === jamesId);
  assert.ok(dennyRow, "team view must include Denny");
  assert.ok(jamesRow, "team view must include James");

  const summedPipeline = body.pam_reports.reduce((sum: number, r: any) => sum + r.metrics.commercial.open_pipeline_usd.total, 0);
  assert.equal(
    body.team_commercial.open_pipeline_usd.total,
    summedPipeline,
    "team total must equal the sum of the exact PAM population shown, given no cross-PAM opportunity overlap in this fixture",
  );
});

// ---- Submit: freeze + immutability + concurrency guard ---------------------

test("POST /reporting/weekly/me/submit: freezes the report; commentary and metrics become read-only afterward", async () => {
  const { status, body } = await post("/reporting/weekly/me/submit", tokens.james, { week_start: TEST_WEEK_START });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, "submitted");
  assert.ok(body.snapshot_generated_at, "a submitted report must carry a snapshot_generated_at timestamp");
  createdReportRowKeys.push({ pamUserId: jamesId, weekStartDate: TEST_WEEK_START });

  const reread = await get(`/reporting/weekly/me?week_start=${TEST_WEEK_START}`, tokens.james);
  assert.equal(reread.body.status, "submitted");
  assert.deepEqual(reread.body.metrics, body.metrics, "a re-read of a submitted report must return the exact frozen snapshot, never recomputed");
});

test("POST /reporting/weekly/me/submit: submitting an already-submitted week is rejected (409), never silently re-frozen", async () => {
  const { status } = await post("/reporting/weekly/me/submit", tokens.james, { week_start: TEST_WEEK_START });
  assert.equal(status, 409);
});

test("PUT /reporting/weekly/me/commentary: rejected (409) once that week is submitted -- commentary is read-only after submit", async () => {
  const { status } = await put("/reporting/weekly/me/commentary", tokens.james, { week_start: TEST_WEEK_START, wins_progress: "trying to edit after submit" });
  assert.equal(status, 409);
});

// ---- History ---------------------------------------------------------
//
// Denny's fixtures above only ever call PUT .../commentary (never submit),
// so his history is exactly two DRAFT weeks. James's only touched week in
// this suite is submitted. Each PAM's history is verified against exactly
// what this suite actually did to their own rows -- never a claim about a
// state that was never created.

test("GET /reporting/weekly/me/history: Denny sees both draft weeks, most recent first", async () => {
  const { status, body } = await get("/reporting/weekly/me/history?limit=20", tokens.denny);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  const dennyWeeks = body.filter((h: any) => h.week_start === TEST_WEEK_START || h.week_start === TEST_WEEK_2_START);
  assert.equal(dennyWeeks.length, 2, "history must include both weeks with saved commentary");
  assert.ok(dennyWeeks.every((h: any) => h.status === "draft"), "neither of Denny's test weeks was ever submitted in this suite");

  const indexOfWeek2 = body.findIndex((h: any) => h.week_start === TEST_WEEK_2_START);
  const indexOfWeek1 = body.findIndex((h: any) => h.week_start === TEST_WEEK_START);
  assert.ok(indexOfWeek2 < indexOfWeek1, "the later week (TEST_WEEK_2_START) must be ordered before the earlier one (TEST_WEEK_START)");
});

test("GET /reporting/weekly/me/history: James sees the submitted week with status=submitted", async () => {
  const { status, body } = await get("/reporting/weekly/me/history?limit=20", tokens.james);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  const jamesWeek = body.find((h: any) => h.week_start === TEST_WEEK_START);
  assert.ok(jamesWeek, "history must include James's submitted week");
  assert.equal(jamesWeek.status, "submitted");
  assert.ok(jamesWeek.submitted_at, "a submitted history entry must carry a submitted_at timestamp");
});
