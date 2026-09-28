// Route-level tests for GET /channel-chief/pam-directory. Run against a
// live dev server backed by a real (disposable) Postgres seeded with the
// standard fixture roster (see src/scripts/seed.ts) -- same pattern as
// tests/pamOverviewRoute.test.ts/tests/channelChief.test.ts. The server
// under test must be started with CHANNEL_CHIEF_API_TOKEN set to the same
// value as process.env.CHANNEL_CHIEF_API_TOKEN below.
//
//   CHANNEL_CHIEF_API_TOKEN=... BASE_URL=http://localhost:8080/api \
//     tsx --test tests/pamDirectoryRoute.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";
const VALID_TOKEN = process.env.CHANNEL_CHIEF_API_TOKEN;

if (!VALID_TOKEN || VALID_TOKEN.trim() === "") {
  throw new Error("CHANNEL_CHIEF_API_TOKEN must be set to the value the running server was started with.");
}

async function getPamDirectory(opts: { token?: string; queryToken?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.queryToken !== undefined) params.set("token", opts.queryToken);
  const qs = params.toString();
  const res = await fetch(`${BASE_URL}/channel-chief/pam-directory${qs ? `?${qs}` : ""}`, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- Auth --------------------------------------------------------------------

test("GET /channel-chief/pam-directory: missing service token is rejected (401)", async () => {
  const { status } = await getPamDirectory();
  assert.equal(status, 401);
});

test("GET /channel-chief/pam-directory: wrong service token is rejected (401)", async () => {
  const { status } = await getPamDirectory({ token: "definitely-not-the-real-token" });
  assert.equal(status, 401);
});

test("GET /channel-chief/pam-directory: the real token passed as a query string parameter is NOT accepted", async () => {
  const { status } = await getPamDirectory({ queryToken: VALID_TOKEN });
  assert.equal(status, 401);
});

// ---- Roster shape and content ---------------------------------------------------

test("GET /channel-chief/pam-directory: returns the seeded PAM roster with the exact requested fields", async () => {
  const { status, body } = await getPamDirectory({ token: VALID_TOKEN });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 5, "expected at least the 5 seeded PAMs (Denny, James, Chase, Vlad, Elena)");

  const denny = body.find((e: any) => e.pam_name === "Denny Morais");
  assert.ok(denny, "expected Denny Morais in the directory");
  assert.equal(denny.pam_email, "denny.morais@druidai.com");
  assert.ok(Array.isArray(denny.territories), "territories is always an array -- never a single territory field");
  assert.ok(
    denny.territories.some((t: any) => t.territory_name === "Portugal, Canada and South America" && typeof t.territory_id === "string" && Array.isArray(t.countries)),
    "expected Denny's owned territory to be listed",
  );
  assert.equal(denny.active, true);
  assert.equal(typeof denny.pam_user_id, "string");

  const allowedKeys = ["pam_user_id", "pam_name", "pam_email", "territories", "active"];
  for (const entry of body) {
    assert.deepEqual(Object.keys(entry).sort(), [...allowedKeys].sort(), "identity-only -- no performance/portfolio/pipeline fields belong on a directory entry");
  }
});

test("GET /channel-chief/pam-directory: the head_of_channels seed user (Irina) never appears -- role must be pam", async () => {
  const { status, body } = await getPamDirectory({ token: VALID_TOKEN });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(
    body.some((e: any) => e.pam_name === "Irina Dochitu"),
    false,
    "head_of_channels must never be listed in the PAM directory",
  );
});

test("GET /channel-chief/pam-directory: ordering is deterministic across repeated calls", async () => {
  const first = await getPamDirectory({ token: VALID_TOKEN });
  const second = await getPamDirectory({ token: VALID_TOKEN });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(
    first.body.map((e: any) => e.pam_user_id),
    second.body.map((e: any) => e.pam_user_id),
    "the same request must return PAMs in the exact same order every time",
  );
  for (let i = 1; i < first.body.length; i++) {
    assert.ok((first.body[i - 1].pam_name as string).localeCompare(first.body[i].pam_name) <= 0, "must be name-ascending");
  }
});
