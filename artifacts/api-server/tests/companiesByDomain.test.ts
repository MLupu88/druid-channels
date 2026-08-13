// Phase 5B-3 blocker A2: route-level tests for GET /companies/by-domain,
// the exact canonical-domain lookup added specifically because
// GET /companies/search (fuzzy substring match, unordered, capped at 20
// results -- see routes/companies.ts's MAX_RESULTS) can silently miss an
// existing company once enough OTHER rows also substring-match the query.
// Run against a live dev server backed by a real (disposable) Postgres --
// same pattern as tests/opportunitiesAuthz.test.ts.
//
//   DATABASE_URL=... SEED_PASSWORD_IRINA=... \
//     BASE_URL=http://localhost:8080/api tsx --test tests/companiesByDomain.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, pool, companiesTable } from "@workspace/db";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080/api";

const CREDENTIALS = {
  irina: { email: "irina.dochitu@druidai.com", password: process.env.SEED_PASSWORD_IRINA, envVar: "SEED_PASSWORD_IRINA" },
};
const missingEnvVars = Object.values(CREDENTIALS)
  .filter((c) => !c.password || c.password.trim() === "")
  .map((c) => c.envVar);
if (missingEnvVars.length > 0) {
  throw new Error(`Missing required seed password environment variable(s): ${missingEnvVars.join(", ")}. Set these to the same values used when seeding the database.`);
}

let token = "";
const createdCompanyIds: string[] = [];

async function login(email: string, password: string) {
  const res = await fetch(`${BASE_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let counter = 0;
function uniqueDomain(label: string): string {
  counter++;
  return `blocker-a2-${label}-${Date.now()}-${counter}.example`;
}

before(async () => {
  const { status, body } = await login(CREDENTIALS.irina.email, CREDENTIALS.irina.password!);
  assert.equal(status, 200, `expected login to succeed, got ${status}: ${JSON.stringify(body)}`);
  token = body.token;
});

after(async () => {
  for (const id of createdCompanyIds) {
    await db.delete(companiesTable).where(eq(companiesTable.id, id));
  }
  await pool.end();
});

test("GET /companies/by-domain resolves an existing company by exact canonical domain", async () => {
  const domain = uniqueDomain("exact");
  const [company] = await db.insert(companiesTable).values({ name: "Blocker A2 Exact Co", domain, country: "US" }).returning();
  createdCompanyIds.push(company!.id);

  const { status, body } = await get(`/companies/by-domain?domain=${encodeURIComponent(domain)}`);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.ambiguous, false);
  assert.equal(body.match?.id, company!.id);
});

test("GET /companies/by-domain finds the exact match even when more than 20 other companies would fuzzy-substring-match the same query", async () => {
  const marker = `blocker-a2-fuzzy-${Date.now()}-${++counter}`;
  const domain = `${marker}.example`;
  const [target] = await db.insert(companiesTable).values({ name: "Blocker A2 Fuzzy Target", domain, country: "US" }).returning();
  createdCompanyIds.push(target!.id);

  // 25 decoys whose NAME contains the same marker substring, so a fuzzy
  // /companies/search?q=<marker> call would return >20 hits and cap out
  // (MAX_RESULTS=20) before reliably including the real domain match.
  for (let i = 0; i < 25; i++) {
    const [decoy] = await db.insert(companiesTable).values({ name: `${marker} decoy ${i}`, country: "US" }).returning();
    createdCompanyIds.push(decoy!.id);
  }

  const { status, body } = await get(`/companies/by-domain?domain=${encodeURIComponent(domain)}`);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.ambiguous, false);
  assert.equal(body.match?.id, target!.id, "the exact-domain lookup must find the real match regardless of decoy volume");
});

test("GET /companies/by-domain returns match:null for a domain that does not exist", async () => {
  const { status, body } = await get(`/companies/by-domain?domain=${encodeURIComponent(uniqueDomain("missing"))}`);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.match, null);
  assert.equal(body.ambiguous, false);
});

test("GET /companies/by-domain never fuzzy-resolves a partial/substring domain", async () => {
  const domain = uniqueDomain("partial-target");
  const [company] = await db.insert(companiesTable).values({ name: "Blocker A2 Partial Co", domain, country: "US" }).returning();
  createdCompanyIds.push(company!.id);

  const partial = domain.slice(0, Math.floor(domain.length / 2));
  const { status, body } = await get(`/companies/by-domain?domain=${encodeURIComponent(partial)}`);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.match, null, "a partial/substring domain must never resolve to the full-domain company");
});

test("GET /companies/by-domain reports ambiguous:true (never an arbitrary pick) when two rows share a canonical domain only by case", async () => {
  const lower = uniqueDomain("ambiguous");
  const upper = lower.toUpperCase();
  const [a] = await db.insert(companiesTable).values({ name: "Blocker A2 Ambiguous A", domain: lower, country: "US" }).returning();
  const [b] = await db.insert(companiesTable).values({ name: "Blocker A2 Ambiguous B", domain: upper, country: "US" }).returning();
  createdCompanyIds.push(a!.id, b!.id);

  const { status, body } = await get(`/companies/by-domain?domain=${encodeURIComponent(lower)}`);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.match, null, "an ambiguous domain must never silently resolve to one of the duplicate rows");
  assert.equal(body.ambiguous, true);
});

test("GET /companies/by-domain resolves a full URL/www input to the same canonical company as its bare domain", async () => {
  const domain = uniqueDomain("canonical-input");
  const [company] = await db.insert(companiesTable).values({ name: "Blocker A2 Canonical Input Co", domain, country: "US" }).returning();
  createdCompanyIds.push(company!.id);

  const { status, body } = await get(`/companies/by-domain?domain=${encodeURIComponent(`https://www.${domain}/pricing`)}`);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.match?.id, company!.id);
});
