// Slice E: Head of Channels / Aniri commercial roll-up. DB-backed service
// tests plus in-process HTTP checks for both routes that consume it (human
// GET /pam-commercial/rollup and Channel Chief
// GET /channel-chief/pam-commercial-rollup). Same harness as
// druidFactsAuthz.test.ts: createServer(app), own fixtures, child-first
// teardown. Any outbound fetch other than to the in-process server fails the
// test -- the roll-up must never reach HubSpot.
//
//   DATABASE_URL=... SESSION_SECRET=... pnpm --filter @workspace/db run migrate   # once
//   DATABASE_URL=... SESSION_SECRET=... tsx --test tests/pamCommercialRollup.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db, pool, companiesTable, territoriesTable, usersTable, partnerRelationshipsTable } from "@workspace/db";
import app from "../src/app";
import { issueSessionToken } from "../src/services/session";
import {
  buildPamCommercialRollup,
  getPamCommercialRollup,
  type PamCommercialRollup,
  type PamCommercialRollupCounts,
} from "../src/services/pamCommercialRollupService";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `PamRollup-${label}-${Date.now()}-${counter}`;
}

const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];
const createdUserIds: string[] = [];

let server: Server;
let baseUrl = "";
const CHANNEL_CHIEF_TOKEN = "test-pam-commercial-rollup-token";
const ORIGINAL_CHANNEL_CHIEF_TOKEN = process.env.CHANNEL_CHIEF_API_TOKEN;

// Every outbound request other than to the in-process server is recorded
// and refused -- HubSpot (or any provider) must never be reached.
const realFetch = globalThis.fetch;
const outboundCalls: string[] = [];

before(async () => {
  process.env.CHANNEL_CHIEF_API_TOKEN = CHANNEL_CHIEF_TOKEN;
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  baseUrl = `http://127.0.0.1:${address.port}/api`;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(baseUrl)) {
      outboundCalls.push(url);
      throw new Error(`Unexpected outbound request: ${url}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (ORIGINAL_CHANNEL_CHIEF_TOKEN === undefined) delete process.env.CHANNEL_CHIEF_API_TOKEN;
  else process.env.CHANNEL_CHIEF_API_TOKEN = ORIGINAL_CHANNEL_CHIEF_TOKEN;
  try {
    if (createdCompanyIds.length > 0) {
      await db.delete(partnerRelationshipsTable).where(inArray(partnerRelationshipsTable.companyId, createdCompanyIds));
    }
    for (const id of createdCompanyIds) await db.delete(companiesTable).where(eq(companiesTable.id, id));
    for (const id of createdTerritoryIds) await db.delete(territoriesTable).where(eq(territoriesTable.id, id));
    for (const id of createdUserIds) await db.delete(usersTable).where(eq(usersTable.id, id));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});

async function makeUser(role: "pam" | "head_of_channels" | "admin" = "pam", active = true) {
  const [user] = await db
    .insert(usersTable)
    .values({ name: uniq("User"), email: `${uniq("user").toLowerCase()}@example.test`, passwordHash: "test-fixture-hash", role, active })
    .returning();
  createdUserIds.push(user!.id);
  return user!;
}

async function makeTerritory(ownerUserId: string | null) {
  const [territory] = await db.insert(territoriesTable).values({ name: uniq("Territory"), ownerUserId }).returning();
  createdTerritoryIds.push(territory!.id);
  return territory!;
}

async function makeCompany(hubspotCompanyId: string | null = null) {
  const [company] = await db
    .insert(companiesTable)
    .values({ name: uniq("Company"), country: "Unknown", domain: `${uniq("d").toLowerCase()}.example`, hubspotCompanyId })
    .returning();
  createdCompanyIds.push(company!.id);
  return company!;
}

async function makeRelationship(values: {
  territoryId: string;
  assignedUserId: string | null;
  status: "active" | "dormant" | "closed" | "needs_review";
  hubspotCompanyId?: string | null;
}) {
  const company = await makeCompany(values.hubspotCompanyId ?? null);
  const [row] = await db
    .insert(partnerRelationshipsTable)
    .values({
      originType: values.status === "needs_review" ? "opportunity_import" : "manual",
      companyId: company.id,
      territoryId: values.territoryId,
      assignedUserId: values.assignedUserId,
      status: values.status,
    })
    .returning();
  return row!;
}

function counts(c: Partial<PamCommercialRollupCounts> = {}): PamCommercialRollupCounts {
  return { confirmed_partners: 0, awaiting_review: 0, crm_linked_confirmed: 0, crm_linked_awaiting_review: 0, ...c };
}

function diff(after: PamCommercialRollupCounts, before: PamCommercialRollupCounts): PamCommercialRollupCounts {
  return {
    confirmed_partners: after.confirmed_partners - before.confirmed_partners,
    awaiting_review: after.awaiting_review - before.awaiting_review,
    crm_linked_confirmed: after.crm_linked_confirmed - before.crm_linked_confirmed,
    crm_linked_awaiting_review: after.crm_linked_awaiting_review - before.crm_linked_awaiting_review,
  };
}

function sum(...all: PamCommercialRollupCounts[]): PamCommercialRollupCounts {
  return all.reduce(
    (acc, c) => ({
      confirmed_partners: acc.confirmed_partners + c.confirmed_partners,
      awaiting_review: acc.awaiting_review + c.awaiting_review,
      crm_linked_confirmed: acc.crm_linked_confirmed + c.crm_linked_confirmed,
      crm_linked_awaiting_review: acc.crm_linked_awaiting_review + c.crm_linked_awaiting_review,
    }),
    counts(),
  );
}

function rowFor(rollup: PamCommercialRollup, pamUserId: string) {
  const rows = rollup.pams.filter((p) => p.pam_user_id === pamUserId);
  assert.equal(rows.length, 1, "each active PAM appears exactly once");
  return rows[0]!;
}

function get(pathname: string, token?: string) {
  return fetch(`${baseUrl}${pathname}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

// ---- Pure aggregation -------------------------------------------------------

test("pure: status buckets, CRM linkage, unassigned and other-assignee buckets", () => {
  const rollup = buildPamCommercialRollup(
    [
      { pam_user_id: "p1", pam_name: "A", pam_email: "a@x", territories: [] },
      { pam_user_id: "p2", pam_name: "B", pam_email: "b@x", territories: [] },
    ],
    [
      { status: "active", assignedUserId: "p1", hubspotCompanyId: "1" },
      { status: "dormant", assignedUserId: "p1", hubspotCompanyId: "  " },
      { status: "needs_review", assignedUserId: "p1", hubspotCompanyId: "2" },
      { status: "closed", assignedUserId: "p1", hubspotCompanyId: "3" },
      { status: "active", assignedUserId: null, hubspotCompanyId: null },
      { status: "needs_review", assignedUserId: "someone-else", hubspotCompanyId: "4" },
    ],
  );
  assert.deepEqual(rollup.pams[0]!.counts, counts({ confirmed_partners: 2, awaiting_review: 1, crm_linked_confirmed: 1, crm_linked_awaiting_review: 1 }));
  assert.deepEqual(rollup.pams[1]!.counts, counts());
  assert.deepEqual(rollup.unassigned, counts({ confirmed_partners: 1 }));
  assert.deepEqual(rollup.other_assignees, counts({ awaiting_review: 1, crm_linked_awaiting_review: 1 }));
  assert.deepEqual(rollup.totals, sum(...rollup.pams.map((p) => p.counts), rollup.unassigned, rollup.other_assignees));
});

// ---- DB-backed semantics ----------------------------------------------------

test("confirmed = active + dormant; needs_review separate; closed excluded; CRM linkage counted without deal metrics", async () => {
  const pam = await makeUser("pam");
  const territory = await makeTerritory(pam.id);
  await makeRelationship({ territoryId: territory.id, assignedUserId: pam.id, status: "active", hubspotCompanyId: "9001" });
  await makeRelationship({ territoryId: territory.id, assignedUserId: pam.id, status: "active" });
  await makeRelationship({ territoryId: territory.id, assignedUserId: pam.id, status: "dormant", hubspotCompanyId: "9002" });
  await makeRelationship({ territoryId: territory.id, assignedUserId: pam.id, status: "needs_review", hubspotCompanyId: "9003" });
  await makeRelationship({ territoryId: territory.id, assignedUserId: pam.id, status: "needs_review" });
  await makeRelationship({ territoryId: territory.id, assignedUserId: pam.id, status: "closed", hubspotCompanyId: "9004" });

  const rollup = await getPamCommercialRollup();
  const row = rowFor(rollup, pam.id);
  assert.deepEqual(row.counts, counts({ confirmed_partners: 3, awaiting_review: 2, crm_linked_confirmed: 2, crm_linked_awaiting_review: 1 }));

  assert.equal(rollup.hubspot_read, "not_performed");
  assert.equal(rollup.ownership_basis, "partner_relationships.assigned_user_id");
  assert.equal(rollup.territory_basis, "context_only");
  assert.deepEqual(rollup.included_statuses.excluded, ["closed"]);
  const forbidden = /deal|pipeline|revenue|amount|health|score|momentum|risk/i;
  for (const key of [...Object.keys(rollup), ...Object.keys(rollup.totals), ...Object.keys(row)]) {
    assert.doesNotMatch(key, forbidden, `no deal/pipeline metric may appear in the roll-up (${key})`);
  }
});

test("assignment uses assigned_user_id, never territory ownership; unassigned stays unassigned", async () => {
  const before = await getPamCommercialRollup();

  const territoryOwner = await makeUser("pam");
  const assignee = await makeUser("pam");
  const ownersTerritory = await makeTerritory(territoryOwner.id);
  // In the owner's territory but assigned to someone else.
  await makeRelationship({ territoryId: ownersTerritory.id, assignedUserId: assignee.id, status: "active", hubspotCompanyId: "9101" });
  // In the owner's territory and unassigned.
  await makeRelationship({ territoryId: ownersTerritory.id, assignedUserId: null, status: "active", hubspotCompanyId: "9102" });
  await makeRelationship({ territoryId: ownersTerritory.id, assignedUserId: null, status: "needs_review" });

  const after = await getPamCommercialRollup();
  assert.deepEqual(rowFor(after, territoryOwner.id).counts, counts(), "the territory owner is credited with nothing they are not assigned");
  assert.deepEqual(rowFor(after, assignee.id).counts, counts({ confirmed_partners: 1, crm_linked_confirmed: 1 }));
  assert.deepEqual(diff(after.unassigned, before.unassigned), counts({ confirmed_partners: 1, awaiting_review: 1, crm_linked_confirmed: 1 }));
  assert.deepEqual(rowFor(after, territoryOwner.id).territories.map((t) => t.territory_id), [ownersTerritory.id], "territory is context on the owner's row");
  assert.deepEqual(rowFor(after, assignee.id).territories, [], "the assignee owns no territory -- none is invented");
});

test("every active PAM appears once (including zero relationships); inactive PAMs and non-PAM assignees go to other_assignees", async () => {
  const before = await getPamCommercialRollup();

  const zeroPam = await makeUser("pam");
  const inactivePam = await makeUser("pam", false);
  const head = await makeUser("head_of_channels");
  const territory = await makeTerritory(null);
  await makeRelationship({ territoryId: territory.id, assignedUserId: inactivePam.id, status: "active" });
  await makeRelationship({ territoryId: territory.id, assignedUserId: head.id, status: "needs_review", hubspotCompanyId: "9201" });

  const after = await getPamCommercialRollup();
  assert.deepEqual(rowFor(after, zeroPam.id).counts, counts());
  assert.equal(after.pams.some((p) => p.pam_user_id === inactivePam.id), false, "inactive PAMs have no row");
  assert.equal(after.pams.some((p) => p.pam_user_id === head.id), false, "non-PAM users have no row");
  assert.deepEqual(diff(after.other_assignees, before.other_assignees), counts({ confirmed_partners: 1, awaiting_review: 1, crm_linked_awaiting_review: 1 }));
  assert.equal(new Set(after.pams.map((p) => p.pam_user_id)).size, after.pams.length, "no duplicate PAM rows");
  assert.deepEqual(after.totals, sum(...after.pams.map((p) => p.counts), after.unassigned, after.other_assignees));
});

test("territories[] support multiple territories and stay contextual", async () => {
  const pam = await makeUser("pam");
  const t1 = await makeTerritory(pam.id);
  const t2 = await makeTerritory(pam.id);
  const otherPam = await makeUser("pam");
  // Assigned to pam but in someone else's territory -- still pam's.
  const foreignTerritory = await makeTerritory(otherPam.id);
  await makeRelationship({ territoryId: foreignTerritory.id, assignedUserId: pam.id, status: "dormant" });

  const rollup = await getPamCommercialRollup();
  const row = rowFor(rollup, pam.id);
  assert.deepEqual(new Set(row.territories.map((t) => t.territory_id)), new Set([t1.id, t2.id]));
  assert.deepEqual(row.counts, counts({ confirmed_partners: 1 }));
  assert.deepEqual(rowFor(rollup, otherPam.id).counts, counts());
});

// ---- Routes -----------------------------------------------------------------

test("GET /pam-commercial/rollup: Head/Admin can read it; a PAM is refused; unauthenticated is 401", async () => {
  const head = await makeUser("head_of_channels");
  const admin = await makeUser("admin");
  const pam = await makeUser("pam");

  for (const user of [head, admin]) {
    const res = await get("/pam-commercial/rollup", issueSessionToken(user.id).token);
    assert.equal(res.status, 200);
    const body = (await res.json()) as PamCommercialRollup;
    rowFor(body, pam.id);
  }
  assert.equal((await get("/pam-commercial/rollup", issueSessionToken(pam.id).token)).status, 403);
  assert.equal((await get("/pam-commercial/rollup")).status, 401);
});

test("GET /channel-chief/pam-commercial-rollup: service token only, and the same result as the human roll-up", async () => {
  const head = await makeUser("head_of_channels");
  const pam = await makeUser("pam");

  assert.equal((await get("/channel-chief/pam-commercial-rollup")).status, 401);
  assert.equal((await get("/channel-chief/pam-commercial-rollup", issueSessionToken(head.id).token)).status, 401, "a human session is not a Channel Chief token");
  assert.equal((await get("/channel-chief/pam-commercial-rollup", issueSessionToken(pam.id).token)).status, 401);

  const human = await get("/pam-commercial/rollup", issueSessionToken(head.id).token);
  const aniri = await get("/channel-chief/pam-commercial-rollup", CHANNEL_CHIEF_TOKEN);
  assert.equal(human.status, 200);
  assert.equal(aniri.status, 200);
  assert.deepEqual(await aniri.json(), await human.json());
});

test("loading the roll-up performs no HubSpot (or any outbound) call", async () => {
  const head = await makeUser("head_of_channels");
  const pam = await makeUser("pam");
  const territory = await makeTerritory(pam.id);
  await makeRelationship({ territoryId: territory.id, assignedUserId: pam.id, status: "active", hubspotCompanyId: "9301" });

  outboundCalls.length = 0;
  await getPamCommercialRollup();
  assert.equal((await get("/pam-commercial/rollup", issueSessionToken(head.id).token)).status, 200);
  assert.equal((await get("/channel-chief/pam-commercial-rollup", CHANNEL_CHIEF_TOKEN)).status, 200);
  assert.deepEqual(outboundCalls, []);

  const source = readFileSync(path.join(__dirname, "../src/services/pamCommercialRollupService.ts"), "utf-8");
  const rollupImports = importSpecifiers(source);
  assert.ok(rollupImports.includes("./pamCommercialSemantics"), "shared rules come from the pure semantics module");
  for (const specifier of rollupImports) {
    assert.equal(isForbiddenProviderModule(specifier), false, `roll-up service must not import provider/AI code: ${specifier}`);
  }
  assert.doesNotMatch(source, /\.insert\(|\.update\(|\.delete\(/, "roll-up service performs no writes");

  // The shared semantics module is itself pure: its only import is type-only.
  const semantics = readFileSync(path.join(__dirname, "../src/services/pamCommercialSemantics.ts"), "utf-8");
  assert.deepEqual(importSpecifiers(semantics), ["@workspace/db"]);
  assert.match(semantics, /^import type \{[^}]*\} from "@workspace\/db";$/m, "semantics module loads nothing at runtime");

  // The guard itself: module paths are what is checked, not identifiers.
  for (const bad of ["./hubspot", "./hubspotDealFacts", "./connections", "./encryption", "./pamCommercialService", "./aiBriefProvider", "./aiChannelBriefService", "./copilotProvider", "./copilotContextService", "./discoveryProviders/ai", "./channelRadarProviders/search"]) {
    assert.equal(isForbiddenProviderModule(bad), true, `guard must reject ${bad}`);
  }
  assert.equal(isForbiddenProviderModule("./pamCommercialSemantics"), false);
});

// Every module specifier in `import ... from "x"`, `export ... from "x"`,
// `import "x"` and `import("x")`, including multi-line import lists.
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)["']([^"']+)["']/g)) specifiers.push(m[1]!);
  return specifiers;
}

// HubSpot transport/facts, provider credential resolution and decryption,
// AI/copilot modules, provider directories -- and pamCommercialService,
// which carries the lazy HubSpot deal path.
function isForbiddenProviderModule(specifier: string): boolean {
  const base = specifier.split("/").pop() ?? specifier;
  return (
    /^(hubspot|hubspotDealFacts|connections|encryption|pamCommercialService)$/.test(base) ||
    /^ai[A-Z]|copilot/i.test(base) ||
    /Providers?(\/|$)/.test(specifier)
  );
}
