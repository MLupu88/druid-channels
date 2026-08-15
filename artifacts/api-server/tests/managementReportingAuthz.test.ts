// Phase 8: route-level authz/scoping regression tests for the management
// reporting endpoints (GET /reporting/management/summary and
// GET /exports/management-pptx). Run against a live dev server backed by a
// real (disposable) Postgres -- same pattern as
// tests/weeklyReportingAuthz.test.ts.
//
//   DATABASE_URL=... SEED_PASSWORD_IRINA=... SEED_PASSWORD_DENNY=... \
//     BASE_URL=http://localhost:8080/api tsx --test tests/managementReportingAuthz.test.ts
//
// WRITTEN BUT NOT RUN in this session: no disposable Postgres or live dev
// server was available or permitted (Phase 8's working rules forbid Docker/
// production DB access, and forbid calling live providers -- every fixture
// below uses currency "USD" only, so no live FX call is made). Written to
// the same convention as tests/weeklyReportingAuthz.test.ts so it can be run
// once a disposable Postgres is provisioned.
import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";

const CREDENTIALS = {
  irina: { email: "irina.dochitu@druidai.com", password: process.env.SEED_PASSWORD_IRINA, envVar: "SEED_PASSWORD_IRINA" }, // head_of_channels
  denny: { email: "denny.morais@druidai.com", password: process.env.SEED_PASSWORD_DENNY, envVar: "SEED_PASSWORD_DENNY" }, // PAM
};

const missingEnvVars = Object.values(CREDENTIALS)
  .filter((c) => !c.password || c.password.trim() === "")
  .map((c) => c.envVar);
if (missingEnvVars.length > 0) {
  throw new Error(`Missing required seed password environment variable(s): ${missingEnvVars.join(", ")}. Set these to the same values used when seeding the database.`);
}

const tokens: Record<string, string> = {};

async function login(email: string, password: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(path: string, token?: string): Promise<{ status: number; body: any; contentType: string | null }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const contentType = res.headers.get("content-type");
  const body = contentType?.includes("application/json") ? await res.json().catch(() => null) : null;
  return { status: res.status, body, contentType };
}

before(async () => {
  for (const [key, cred] of Object.entries(CREDENTIALS)) {
    const { status, body } = await login(cred.email, cred.password!);
    assert.equal(status, 200, `expected ${key} to log in, got ${status}: ${JSON.stringify(body)}`);
    tokens[key] = body.token;
  }
});

// ---- GET /reporting/management/summary -------------------------------------

test("GET /reporting/management/summary: Head/Admin can view it", async () => {
  const { status, body } = await get("/reporting/management/summary?currency=USD", tokens.irina);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(body.report_context);
  assert.ok(body.weekly);
  assert.ok(body.quarter_to_date);
  assert.ok(body.comparisons);
  assert.ok(Array.isArray(body.management_insights));
  assert.ok(body.data_quality);
});

test("GET /reporting/management/summary: quarter_to_date.commercial is buildHeadOfChannelsData()'s verbatim camelCase shape, never the HTTP-shaped HeadOfChannelsKpis contract", async () => {
  const { status, body } = await get("/reporting/management/summary?currency=USD", tokens.irina);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  const commercial = body.quarter_to_date.commercial;
  assert.ok(Array.isArray(commercial.partnerDevelopment), "quarter_to_date.commercial.partnerDevelopment must exist");
  assert.ok(Array.isArray(commercial.weeklyCommercial), "quarter_to_date.commercial.weeklyCommercial must exist");
  assert.ok(Array.isArray(commercial.weeklyMarketing), "quarter_to_date.commercial.weeklyMarketing must exist");
  assert.ok(commercial.fx, "quarter_to_date.commercial.fx must exist");
});

test("GET /reporting/management/summary: PAM is rejected (403) -- requireAdmin excludes the pam role", async () => {
  const { status } = await get("/reporting/management/summary?currency=USD", tokens.denny);
  assert.equal(status, 403);
});

test("GET /reporting/management/summary: unauthenticated request is rejected", async () => {
  const { status } = await get("/reporting/management/summary?currency=USD");
  assert.equal(status, 401);
});

test("GET /reporting/management/summary: a non-canonical-Monday week_start is rejected with 400, never silently coerced", async () => {
  const { status } = await get("/reporting/management/summary?week_start=2026-07-14&currency=USD", tokens.irina); // a Tuesday
  assert.equal(status, 400);
});

test("GET /reporting/management/summary: quarter_to_date_period_key reflects the CURRENT quarter regardless of a historical week_start -- never a historical QTD reconstruction", async () => {
  const currentResult = await get("/reporting/management/summary?currency=USD", tokens.irina);
  assert.equal(currentResult.status, 200);

  // A real, far-in-the-past canonical Monday -- 2025-01-06.
  const historicalResult = await get("/reporting/management/summary?week_start=2025-01-06&currency=USD", tokens.irina);
  assert.equal(historicalResult.status, 200);

  assert.equal(
    historicalResult.body.report_context.quarter_to_date_period_key,
    currentResult.body.report_context.quarter_to_date_period_key,
    "quarter_to_date must always reflect the current quarter, independent of the selected week_start",
  );
  assert.equal(historicalResult.body.report_context.week_start, "2025-01-06");
  assert.match(historicalResult.body.report_context.quarter_to_date_note, /current quarter/i);
});

test("GET /reporting/management/summary: comparisons.week_over_week.open_pipeline is reported as current-state only, never a fabricated historical delta", async () => {
  const { status, body } = await get("/reporting/management/summary?currency=USD", tokens.irina);
  assert.equal(status, 200);
  assert.equal(body.comparisons.week_over_week.open_pipeline.available, false);
  assert.ok(body.comparisons.week_over_week.open_pipeline.current_open_pipeline_usd);
});

test("GET /reporting/management/summary: quarter_to_date.pam_comparison never asserts a fabricated Global-equals-sum-of-PAMs equality -- reconciles/reconciliation_note pass through verbatim", async () => {
  const { status, body } = await get("/reporting/management/summary?currency=USD", tokens.irina);
  assert.equal(status, 200);
  assert.equal(typeof body.quarter_to_date.pam_comparison.reconciles, "boolean");
  if (!body.quarter_to_date.pam_comparison.reconciles) {
    assert.ok(typeof body.quarter_to_date.pam_comparison.reconciliation_note === "string" && body.quarter_to_date.pam_comparison.reconciliation_note.length > 0);
  }
});

// ---- GET /exports/management-pptx -------------------------------------------

test("GET /exports/management-pptx: Head/Admin receives a PowerPoint file", async () => {
  const res = await fetch(`${BASE_URL}/exports/management-pptx?currency=USD`, { headers: { Authorization: `Bearer ${tokens.irina}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0);
});

test("GET /exports/management-pptx: PAM is rejected (403)", async () => {
  const res = await fetch(`${BASE_URL}/exports/management-pptx?currency=USD`, { headers: { Authorization: `Bearer ${tokens.denny}` } });
  assert.equal(res.status, 403);
});

test("GET /exports/quarterly-pptx: unaffected by the Phase 8 management-pptx addition -- still 200 for Head/Admin", async () => {
  const res = await fetch(`${BASE_URL}/exports/quarterly-pptx?currency=USD`, { headers: { Authorization: `Bearer ${tokens.irina}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
});
