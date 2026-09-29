// Route-level tests for GET /channel-chief/pam-overview. Run against a live
// dev server backed by a real (disposable) Postgres seeded with the
// standard fixture roster (see src/scripts/seed.ts) -- same pattern as
// tests/channelChief.test.ts. The server under test must be started with
// CHANNEL_CHIEF_API_TOKEN set to the same value as
// process.env.CHANNEL_CHIEF_API_TOKEN below.
//
//   CHANNEL_CHIEF_API_TOKEN=... BASE_URL=http://localhost:8080/api \
//     tsx --test tests/pamOverviewRoute.test.ts
//
// Exercises the exact bug this endpoint fixes: Aniri asked "ce poti sa-mi
// zici de denny?" / "denny morais" and had no PAM-scoped data to answer
// from -- see seed.ts's "Denny Morais" (denny.morais@druidai.com) fixture.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";
const VALID_TOKEN = process.env.CHANNEL_CHIEF_API_TOKEN;

if (!VALID_TOKEN || VALID_TOKEN.trim() === "") {
  throw new Error("CHANNEL_CHIEF_API_TOKEN must be set to the value the running server was started with.");
}

async function getPamOverview(opts: { token?: string; queryToken?: string; pamName?: string; period?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.pamName !== undefined) params.set("pam_name", opts.pamName);
  if (opts.period !== undefined) params.set("period", opts.period);
  if (opts.queryToken !== undefined) params.set("token", opts.queryToken);
  const qs = params.toString();
  const res = await fetch(`${BASE_URL}/channel-chief/pam-overview${qs ? `?${qs}` : ""}`, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- Auth --------------------------------------------------------------------

test("GET /channel-chief/pam-overview: missing service token is rejected (401)", async () => {
  const { status } = await getPamOverview({ pamName: "Denny" });
  assert.equal(status, 401);
});

test("GET /channel-chief/pam-overview: wrong service token is rejected (401)", async () => {
  const { status } = await getPamOverview({ token: "definitely-not-the-real-token", pamName: "Denny" });
  assert.equal(status, 401);
});

test("GET /channel-chief/pam-overview: the real token passed as a query string parameter is NOT accepted", async () => {
  const { status } = await getPamOverview({ queryToken: VALID_TOKEN, pamName: "Denny" });
  assert.equal(status, 401);
});

// ---- Validation ----------------------------------------------------------------

test("GET /channel-chief/pam-overview: missing pam_name is rejected (400)", async () => {
  const { status } = await getPamOverview({ token: VALID_TOKEN });
  assert.equal(status, 400);
});

test("GET /channel-chief/pam-overview: invalid period is rejected (400)", async () => {
  const { status } = await getPamOverview({ token: VALID_TOKEN, pamName: "Denny", period: "not-a-real-period" });
  assert.equal(status, 400);
});

// ---- Name resolution: the exact bug this endpoint fixes -----------------------

test("GET /channel-chief/pam-overview: 'Denny' resolves uniquely to Denny Morais", async () => {
  const { status, body } = await getPamOverview({ token: VALID_TOKEN, pamName: "Denny" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.identity.pam_name, "Denny Morais");
  assert.equal(body.identity.pam_email, "denny.morais@druidai.com");
});

test("GET /channel-chief/pam-overview: case-insensitive lookup ('denny') resolves the same PAM", async () => {
  const { status, body } = await getPamOverview({ token: VALID_TOKEN, pamName: "denny" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.identity.pam_name, "Denny Morais");
});

test("GET /channel-chief/pam-overview: exact full-name lookup ('Denny Morais') resolves correctly", async () => {
  const { status, body } = await getPamOverview({ token: VALID_TOKEN, pamName: "Denny Morais" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.identity.pam_name, "Denny Morais");
  assert.ok(
    body.identity.territories.some((t: { territory_name: string }) => t.territory_name === "Portugal, Canada and South America"),
    "every owned territory is listed, never just the first",
  );
});

test("GET /channel-chief/pam-overview: unknown PAM name is reported explicitly (404), never guessed", async () => {
  const { status, body } = await getPamOverview({ token: VALID_TOKEN, pamName: "Nobody Real Zzzqx" });
  assert.equal(status, 404);
  assert.ok(body?.error);
});

test("GET /channel-chief/pam-overview: a well-formed period is accepted and echoed back", async () => {
  const { status, body } = await getPamOverview({ token: VALID_TOKEN, pamName: "Denny", period: "2026-q3" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.identity.period_key, "2026-q3");
});

// ---- Bounded response -----------------------------------------------------------

test("GET /channel-chief/pam-overview: every list field is bounded (<= 10), regardless of how much data exists", async () => {
  const { status, body } = await getPamOverview({ token: VALID_TOKEN, pamName: "Denny" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  const boundedArrays = [
    body.portfolio.assigned_partners,
    body.portfolio.needs_attention,
    body.portfolio.recent_activity,
    body.druid_recorded_opportunities.largest_open,
    body.druid_recorded_opportunities.upcoming_expected_closes,
    body.druid_recorded_opportunities.past_due_open,
    body.recruitment.priority_recruitments,
    body.activity.recent,
  ];
  for (const arr of boundedArrays) {
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length <= 10, `expected a bounded list, got ${arr.length} rows`);
  }
});

// ---- DRUID-recorded opportunities are never presented as the HubSpot pipeline ----

test("GET /channel-chief/pam-overview: opportunities are labelled DRUID-recorded with the HubSpot pipeline explicitly not included", async () => {
  const { status, body } = await getPamOverview({ token: VALID_TOKEN, pamName: "Denny" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.pipeline, undefined);
  assert.equal(body.druid_recorded_opportunities.source, "druid_partner_opportunities");
  assert.equal(body.druid_recorded_opportunities.hubspot_pipeline, "not_included");
});

// ---- No fabricated performance --------------------------------------------------

test("GET /channel-chief/pam-overview: performance rows are only ever ahead/behind/no_target/unavailable -- never a fabricated score", async () => {
  const { status, body } = await getPamOverview({ token: VALID_TOKEN, pamName: "Denny" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  for (const row of body.performance) {
    assert.ok(["ahead", "behind", "no_target", "unavailable"].includes(row.status));
    if (row.status === "no_target") {
      assert.equal(row.target, null);
    }
    // unavailable: a real target exists but the actual is unknown -- never
    // a fabricated 0 actual or 0% progress.
    if (row.status === "unavailable") {
      assert.notEqual(row.target, null);
      assert.equal(row.actual, null);
      assert.equal(row.progress_percent, null);
    }
    if (row.status === "ahead" || row.status === "behind") {
      assert.notEqual(row.actual, null);
    }
  }
});
