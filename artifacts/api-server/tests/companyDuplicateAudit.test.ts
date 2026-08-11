// Phase 3B: pure unit tests for the read-only audit tool's new checks
// (src/scripts/auditCompanyDuplicates.ts). No DB, no live provider --
// companyDuplicateAudit.ts has zero DB/network imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findNonCanonicalRows, findActiveProspectConflicts } from "../src/services/companyDuplicateAudit";

test("findNonCanonicalRows: flags a stored domain that isn't already canonical", () => {
  const rows = findNonCanonicalRows([
    { id: "c1", domain: "www.acme.example" }, // not canonical -- toRegistrableDomain strips www
    { id: "c2", domain: "acme.example" }, // already canonical
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.companyId, "c1");
  assert.equal(rows[0]!.storedDomain, "www.acme.example");
  assert.equal(rows[0]!.canonicalDomain, "acme.example");
});

test("findNonCanonicalRows: a null domain is never flagged", () => {
  const rows = findNonCanonicalRows([{ id: "c1", domain: null }]);
  assert.equal(rows.length, 0);
});

test("findNonCanonicalRows: an unparseable stored domain is flagged with a null canonical form, not skipped", () => {
  const rows = findNonCanonicalRows([{ id: "c1", domain: "not a domain at all" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.canonicalDomain, null);
});

test("findNonCanonicalRows: a subdomain stored verbatim (e.g. ir.acme.example) is flagged", () => {
  const rows = findNonCanonicalRows([{ id: "c1", domain: "ir.acme.example" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.canonicalDomain, "acme.example");
});

test("findActiveProspectConflicts: two non-rejected prospects for the same company+territory are flagged", () => {
  const conflicts = findActiveProspectConflicts([
    { id: "p1", companyId: "co1", territoryId: "t1", status: "new" },
    { id: "p2", companyId: "co1", territoryId: "t1", status: "accepted" },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.companyId, "co1");
  assert.equal(conflicts[0]!.territoryId, "t1");
  assert.deepEqual(conflicts[0]!.prospectIds.sort(), ["p1", "p2"]);
});

test("findActiveProspectConflicts: a rejected prospect never counts toward a conflict", () => {
  const conflicts = findActiveProspectConflicts([
    { id: "p1", companyId: "co1", territoryId: "t1", status: "rejected" },
    { id: "p2", companyId: "co1", territoryId: "t1", status: "new" },
  ]);
  assert.equal(conflicts.length, 0, "one rejected + one active is not a conflict -- exactly one active prospect exists");
});

test("findActiveProspectConflicts: the same company in two different territories is never a conflict", () => {
  const conflicts = findActiveProspectConflicts([
    { id: "p1", companyId: "co1", territoryId: "t1", status: "new" },
    { id: "p2", companyId: "co1", territoryId: "t2", status: "new" },
  ]);
  assert.equal(conflicts.length, 0);
});

test("findActiveProspectConflicts: no conflicts at all returns an empty array", () => {
  const conflicts = findActiveProspectConflicts([{ id: "p1", companyId: "co1", territoryId: "t1", status: "new" }]);
  assert.equal(conflicts.length, 0);
});
