// Phase 11.1: regression coverage for the prospect-delete recruitment
// guard. partner_recruitments.prospectId -> prospects.id is onDelete:
// cascade (see partner_recruitments.ts), so a naive DELETE /prospects/:id
// on a prospect that already has a recruitment record would silently wipe
// the recruitment row and, transitively, its full partner_recruitment_history
// (also onDelete: cascade) -- including a signed partner's trail. This
// suite proves the application-level guard added in
// services/partnerRecruitmentService.ts (assertProspectHasNoRecruitment)
// blocks that before Postgres's cascade ever runs, that it applies
// regardless of stage (exercised at "signed", the terminal case the audit
// specifically flagged) and regardless of caller role, and that it doesn't
// disturb the existing territory/ownership authorization checks that run
// before it in the route.
//
// DB-backed, in-process HTTP -- no external dev server required. Fixtures
// are inserted directly via @workspace/db (own territory/users/company/
// prospect rows per test, cleaned up in after()); requests go through the
// real Express app (src/app.ts, no side effects on import) bound to an
// ephemeral port, with session tokens minted directly via
// issueSessionToken -- exercises the actual requireAuth middleware and
// route handler, not a reimplementation of either.
//
//   DATABASE_URL=... SESSION_SECRET=... tsx --test tests/prospectDeleteGuard.test.ts
// or `pnpm run test:prospect-delete-guard` with the same env exported.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  territoriesTable,
  companiesTable,
  prospectsTable,
  prospectActivityTable,
  partnerRecruitmentsTable,
  partnerRecruitmentHistoryTable,
  partnerRelationshipsTable,
} from "@workspace/db";
import app from "../src/app";
import { issueSessionToken } from "../src/services/session";
import { acceptForRecruitment, transitionRecruitmentStage } from "../src/services/partnerRecruitmentService";

let server: Server;
let baseUrl: string;

const createdUserIds: string[] = [];
const createdTerritoryIds: string[] = [];
const createdCompanyIds: string[] = [];

let pamAId = "";
let pamAToken = "";
let pamBId = "";
let pamBToken = "";
let otherUserInTerritoryAId = "";
let headId = "";
let headToken = "";
let territoryAId = "";

let runId = 0;
function uniqueDomain(): string {
  runId++;
  return `phase11-1-delete-guard-${Date.now()}-${runId}.example`;
}

async function insertUser(name: string, role: "pam" | "head_of_channels", territory: string | null): Promise<{ id: string; token: string }> {
  const [user] = await db
    .insert(usersTable)
    .values({ name, email: `${name.toLowerCase().replace(/\s+/g, ".")}.${Date.now()}.${Math.random().toString(36).slice(2)}@phase11-test.example`, role, territory, active: true })
    .returning();
  createdUserIds.push(user!.id);
  const { token } = issueSessionToken(user!.id);
  return { id: user!.id, token };
}

async function insertProspect(companyId: string, territoryId: string, assignedUserId: string) {
  const [prospect] = await db
    .insert(prospectsTable)
    .values({
      companyId,
      territoryId,
      assignedUserId,
      partnerType: "System integrator",
      priority: "A",
      whyItFits: "Phase 11.1 fixture",
      whyNow: "Phase 11.1 fixture",
      status: "accepted",
      acceptedAt: new Date(),
    })
    .returning();
  await db.insert(prospectActivityTable).values({ prospectId: prospect!.id, eventType: "accepted", timestamp: new Date() });
  return prospect!;
}

async function insertCompany(): Promise<string> {
  const [company] = await db.insert(companiesTable).values({ name: `Phase 11.1 Co ${runId}`, domain: uniqueDomain(), country: "Portugal" }).returning();
  createdCompanyIds.push(company!.id);
  return company!.id;
}

function authedFetch(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral TCP port");
  baseUrl = `http://127.0.0.1:${address.port}/api`;

  const [territoryA] = await db
    .insert(territoriesTable)
    .values({ name: `Phase 11.1 Territory A ${Date.now()}`, countries: ["PT"] })
    .returning();
  territoryAId = territoryA!.id;
  createdTerritoryIds.push(territoryAId);

  const [territoryB] = await db
    .insert(territoriesTable)
    .values({ name: `Phase 11.1 Territory B ${Date.now()}`, countries: ["GB"] })
    .returning();
  createdTerritoryIds.push(territoryB!.id);

  const pamA = await insertUser("Phase111 PamA", "pam", territoryA!.name);
  pamAId = pamA.id;
  pamAToken = pamA.token;
  await db.update(territoriesTable).set({ ownerUserId: pamAId }).where(eq(territoriesTable.id, territoryAId));

  const pamB = await insertUser("Phase111 PamB", "pam", territoryB!.name);
  pamBId = pamB.id;
  pamBToken = pamB.token;
  await db.update(territoriesTable).set({ ownerUserId: pamBId }).where(eq(territoriesTable.id, territoryB!.id));

  const other = await insertUser("Phase111 Other", "pam", territoryA!.name);
  otherUserInTerritoryAId = other.id;

  const head = await insertUser("Phase111 Head", "head_of_channels", null);
  headId = head.id;
  headToken = head.token;
});

after(async () => {
  // Explicit, child-first teardown. Deliberately NOT relying on a
  // company-level cascade: partner_recruitments.company_id -> companies.id
  // has no onDelete clause (RESTRICT), so deleting a company that still
  // has a recruitment row would fail outright rather than clean up. Order:
  // partner_relationships (only reached by the "signed" test, via
  // originRecruitmentId -- its own history cascades from it) -> recruitment
  // history -> recruitment -> prospect activity -> prospect -> company.
  for (const companyId of createdCompanyIds) {
    const rows = await db.select({ id: prospectsTable.id }).from(prospectsTable).where(eq(prospectsTable.companyId, companyId));
    for (const row of rows) {
      const recruitments = await db
        .select({ id: partnerRecruitmentsTable.id })
        .from(partnerRecruitmentsTable)
        .where(eq(partnerRecruitmentsTable.prospectId, row.id));
      for (const recruitment of recruitments) {
        await db.delete(partnerRelationshipsTable).where(eq(partnerRelationshipsTable.originRecruitmentId, recruitment.id));
        await db.delete(partnerRecruitmentHistoryTable).where(eq(partnerRecruitmentHistoryTable.recruitmentId, recruitment.id));
      }
      await db.delete(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.prospectId, row.id));
      await db.delete(prospectActivityTable).where(eq(prospectActivityTable.prospectId, row.id));
      await db.delete(prospectsTable).where(eq(prospectsTable.id, row.id));
    }
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  for (const territoryId of createdTerritoryIds) {
    await db.update(territoriesTable).set({ ownerUserId: null }).where(eq(territoriesTable.id, territoryId));
  }
  for (const userId of createdUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }
  for (const territoryId of createdTerritoryIds) {
    await db.delete(territoriesTable).where(eq(territoriesTable.id, territoryId));
  }
  // Node's global fetch (undici) keeps its connection to the ephemeral
  // server alive by default -- server.close() alone would otherwise hang
  // forever waiting for a socket the test client itself never closes.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("a prospect with no recruitment can still be deleted (existing behavior preserved)", async () => {
  const companyId = await insertCompany();
  const prospect = await insertProspect(companyId, territoryAId, pamAId);

  const res = await authedFetch(`/prospects/${prospect.id}`, pamAToken, { method: "DELETE" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);

  const [remaining] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, prospect.id));
  assert.equal(remaining, undefined, "prospect row should be gone");
  const activity = await db.select().from(prospectActivityTable).where(eq(prospectActivityTable.prospectId, prospect.id));
  assert.equal(activity.length, 0, "activity rows should be gone");
});

test("a prospect with a recruitment cannot be deleted, and returns 409 with the intentional message", async () => {
  const companyId = await insertCompany();
  const prospect = await insertProspect(companyId, territoryAId, pamAId);
  await acceptForRecruitment({ id: prospect.id, companyId, territoryId: territoryAId, assignedUserId: pamAId }, pamAId);

  const res = await authedFetch(`/prospects/${prospect.id}`, pamAToken, { method: "DELETE" });
  assert.equal(res.status, 409, "must be an intentional 409, not a raw DB failure (500) or a silent success (200)");
  const body = await res.json();
  assert.match(body.error, /recruitment/i);
  assert.match(body.error, /cannot be permanently deleted/i);

  const [prospectRow] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, prospect.id));
  assert.ok(prospectRow, "prospect row must remain intact after a rejected delete");
  const [recruitmentRow] = await db.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.prospectId, prospect.id));
  assert.ok(recruitmentRow, "recruitment row must remain intact after a rejected delete");
  const history = await db.select().from(partnerRecruitmentHistoryTable).where(eq(partnerRecruitmentHistoryTable.recruitmentId, recruitmentRow!.id));
  assert.ok(history.length > 0, "recruitment history must remain intact after a rejected delete");
});

test("the guard blocks deletion at every stage, including the terminal 'signed' stage -- not just a special case", async () => {
  const companyId = await insertCompany();
  const prospect = await insertProspect(companyId, territoryAId, pamAId);
  const { recruitment } = await acceptForRecruitment({ id: prospect.id, companyId, territoryId: territoryAId, assignedUserId: pamAId }, pamAId);
  await transitionRecruitmentStage(recruitment.id, "contacting", pamAId);
  await transitionRecruitmentStage(recruitment.id, "engaged", pamAId);
  await transitionRecruitmentStage(recruitment.id, "agreement", pamAId);
  await transitionRecruitmentStage(recruitment.id, "signed", pamAId);

  // Head/Admin, not the owning PAM -- the guard is a data-integrity rule,
  // not an authorization rule, so it must apply here too.
  const res = await authedFetch(`/prospects/${prospect.id}`, headToken, { method: "DELETE" });
  assert.equal(res.status, 409);

  const [recruitmentRow] = await db.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.id, recruitment.id));
  assert.equal(recruitmentRow!.stage, "signed", "the signed partner's recruitment record must survive untouched");
  const history = await db.select().from(partnerRecruitmentHistoryTable).where(eq(partnerRecruitmentHistoryTable.recruitmentId, recruitment.id));
  assert.equal(history.length, 5, "the full accepted->...->signed history must survive untouched");
});

test("existing territory-scoped authorization still blocks a cross-territory PAM before the recruitment guard ever runs", async () => {
  const companyId = await insertCompany();
  const prospect = await insertProspect(companyId, territoryAId, pamAId);
  await acceptForRecruitment({ id: prospect.id, companyId, territoryId: territoryAId, assignedUserId: pamAId }, pamAId);

  // pamB owns Territory B, not A -- must still be a 403 (unchanged existing
  // behavior), not a 409 that would leak "this record exists and has a
  // recruitment" to someone with no access to it at all.
  const res = await authedFetch(`/prospects/${prospect.id}`, pamBToken, { method: "DELETE" });
  assert.equal(res.status, 403);

  const [prospectRow] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, prospect.id));
  assert.ok(prospectRow, "prospect must remain intact after a forbidden delete attempt");
  const [recruitmentRow] = await db.select().from(partnerRecruitmentsTable).where(eq(partnerRecruitmentsTable.prospectId, prospect.id));
  assert.ok(recruitmentRow, "recruitment must remain intact after a forbidden delete attempt");
});

test("existing assigned-user ownership authorization still blocks a same-territory PAM who isn't the assignee", async () => {
  const companyId = await insertCompany();
  // Assigned to otherUserInTerritoryAId, not pamA -- same territory, wrong
  // owner. No recruitment involved: this proves the pre-existing
  // assertOwnUserAccess check is untouched by this change.
  const prospect = await insertProspect(companyId, territoryAId, otherUserInTerritoryAId);

  const res = await authedFetch(`/prospects/${prospect.id}`, pamAToken, { method: "DELETE" });
  assert.equal(res.status, 403);

  const [prospectRow] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, prospect.id));
  assert.ok(prospectRow, "prospect must remain intact after a forbidden delete attempt");
});
