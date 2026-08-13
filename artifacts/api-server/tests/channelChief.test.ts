// Route-level tests for the Aniri/Channel Chief snapshot endpoint. Run
// against a live dev server backed by a real (disposable) Postgres -- same
// pattern as tests/opportunitiesAuthz.test.ts. The server under test must be
// started with CHANNEL_CHIEF_API_TOKEN set to the same value as
// process.env.CHANNEL_CHIEF_API_TOKEN below.
//
//   CHANNEL_CHIEF_API_TOKEN=... SEED_PASSWORD_IRINA=... \
//     BASE_URL=http://localhost:8080/api tsx --test tests/channelChief.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";
const VALID_TOKEN = process.env.CHANNEL_CHIEF_API_TOKEN;
const HUMAN_PASSWORD = process.env.SEED_PASSWORD_IRINA;
const HUMAN_EMAIL = "irina.dochitu@druidai.com";

if (!VALID_TOKEN || VALID_TOKEN.trim() === "") {
  throw new Error("CHANNEL_CHIEF_API_TOKEN must be set to the value the running server was started with.");
}
if (!HUMAN_PASSWORD || HUMAN_PASSWORD.trim() === "") {
  throw new Error("SEED_PASSWORD_IRINA must be set to the same value used when seeding the database.");
}

const TOP_N_BOUND = 5;

async function getSnapshot(opts: { token?: string; queryToken?: string; period?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.period !== undefined) params.set("period", opts.period);
  if (opts.queryToken !== undefined) params.set("token", opts.queryToken);
  const qs = params.toString();
  const res = await fetch(`${BASE_URL}/channel-chief/snapshot${qs ? `?${qs}` : ""}`, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- Auth ------------------------------------------------------------------

test("GET /channel-chief/snapshot: missing service token is rejected (401)", async () => {
  const { status } = await getSnapshot();
  assert.equal(status, 401);
});

test("GET /channel-chief/snapshot: wrong service token is rejected (401)", async () => {
  const { status } = await getSnapshot({ token: "definitely-not-the-real-token" });
  assert.equal(status, 401);
});

test("GET /channel-chief/snapshot: the real token passed as a query string parameter is NOT accepted", async () => {
  const { status } = await getSnapshot({ queryToken: VALID_TOKEN });
  assert.equal(status, 401);
});

test("GET /channel-chief/snapshot: valid Authorization: Bearer service token is allowed", async () => {
  const { status, body } = await getSnapshot({ token: VALID_TOKEN });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
});

// ---- Period validation -------------------------------------------------------

test("GET /channel-chief/snapshot: invalid period is rejected (400)", async () => {
  const { status } = await getSnapshot({ token: VALID_TOKEN, period: "not-a-real-period" });
  assert.equal(status, 400);
});

test("GET /channel-chief/snapshot: a well-formed period is accepted", async () => {
  const { status, body } = await getSnapshot({ token: VALID_TOKEN, period: "2026-q3" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.period_key, "2026-q3");
});

test("GET /channel-chief/snapshot: discovery.top_priority_prospects is DB-LIMIT-bounded to <= 5, regardless of how many prospects exist", async () => {
  const { status, body } = await getSnapshot({ token: VALID_TOKEN });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(Array.isArray(body.discovery.top_priority_prospects));
  assert.ok(body.discovery.top_priority_prospects.length <= TOP_N_BOUND);
  // total_prospect_count reflects the full scope (a DB-level aggregate
  // count), which may legitimately exceed the bounded top-N list length.
  assert.equal(typeof body.discovery.total_prospect_count, "number");
});

// ---- Shape / boundedness / factual content ----------------------------------

test("GET /channel-chief/snapshot: response is bounded, deterministic factual JSON -- never model-generated prose", async () => {
  const { status, body } = await getSnapshot({ token: VALID_TOKEN, period: "2026-q3" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

  assert.equal(typeof body.period, "string");
  assert.equal(body.period_key, "2026-q3");
  assert.equal(typeof body.generated_at, "string");

  assert.ok(Array.isArray(body.performance.partner_development));
  assert.ok(Array.isArray(body.performance.weekly_commercial));
  assert.ok(Array.isArray(body.performance.weekly_marketing));

  assert.ok(Array.isArray(body.recruitment.top_stalled));
  assert.ok(body.recruitment.top_stalled.length <= TOP_N_BOUND, "recruitment.top_stalled must stay bounded, never a full-table dump");
  assert.ok(Array.isArray(body.portfolio.top_needs_attention));
  assert.ok(body.portfolio.top_needs_attention.length <= TOP_N_BOUND, "portfolio.top_needs_attention must stay bounded");
  assert.ok(Array.isArray(body.discovery.top_priority_prospects));
  assert.ok(body.discovery.top_priority_prospects.length <= TOP_N_BOUND, "discovery.top_priority_prospects must stay bounded");
  assert.ok(Array.isArray(body.activity.recent));
  assert.ok(body.activity.recent.length <= TOP_N_BOUND, "activity.recent must stay bounded");

  assert.ok(Array.isArray(body.data_quality_notes));

  // Never AI-generated conversational output -- that's Aniri's job, not this endpoint's.
  assert.equal(body.answer, undefined);
  assert.equal(body.suggested_route, undefined);
  assert.equal(body.follow_ups, undefined);

  // Never a human identity -- this is a machine-to-machine boundary.
  assert.equal(body.actingUser, undefined);
  assert.equal(body.identity, undefined);
});

test("GET /channel-chief/snapshot: calling the same period twice yields identical counts (deterministic, not randomized/model-generated)", async () => {
  const first = await getSnapshot({ token: VALID_TOKEN, period: "2026-q3" });
  const second = await getSnapshot({ token: VALID_TOKEN, period: "2026-q3" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.body.recruitment, second.body.recruitment);
  assert.deepEqual(first.body.portfolio, second.body.portfolio);
  assert.deepEqual(first.body.discovery, second.body.discovery);
  assert.deepEqual(first.body.data_quality_notes, second.body.data_quality_notes);
  assert.equal(first.body.period, second.body.period);
});

// ---- Existing human auth is unaffected --------------------------------------

test("existing human auth routes are unaffected by the Channel Chief auth path", async () => {
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: HUMAN_EMAIL, password: HUMAN_PASSWORD }),
  });
  assert.equal(loginRes.status, 200, "human login must still work unaffected");
  const loginBody = await loginRes.json();

  // A real human session token must never be accepted by the Channel Chief route.
  const snapshotWithSessionToken = await getSnapshot({ token: loginBody.token });
  assert.equal(snapshotWithSessionToken.status, 401, "a human session token must never authenticate the Channel Chief route");

  // The Channel Chief service token must never be honored as a human session on an ordinary requireAuth route.
  const meRes = await fetch(`${BASE_URL}/auth/me`, { headers: { Authorization: `Bearer ${VALID_TOKEN}` } });
  assert.equal(meRes.status, 401, "the Channel Chief service token must never authenticate a human-session route");
});
