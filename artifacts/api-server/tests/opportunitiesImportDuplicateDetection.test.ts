// Phase 5B-3 correction: pure unit tests for
// routes/opportunities.ts's isSourceExternalUniqueViolation -- the
// predicate that decides whether a DB insert failure on POST /opportunities
// gets reported as the historical-import duplicate 409, vs. rethrown
// unchanged. No DB connection is opened (routes/opportunities.ts imports
// @workspace/db, which only requires DATABASE_URL to be *set*, not
// reachable, at module load -- same placeholder-URL convention as this
// project's other module-scope-import unit tests, e.g.
// test:discovery-providers).
//
//   DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder \
//     tsx --test tests/opportunitiesImportDuplicateDetection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSourceExternalUniqueViolation } from "../src/routes/opportunities";

function drizzleWrappedError(cause: unknown): Error {
  // Mirrors the real shape: drizzle-orm's node-postgres driver wraps the
  // underlying `pg` DatabaseError in a "Failed query: ..." Error with
  // `.cause` set to the original (see tests/migrationInvariants.test.ts's
  // isUniqueViolation helper for the same documented shape).
  return new Error("Failed query: insert into partner_opportunities...", { cause });
}

test("matches: 23505 on exactly partner_opportunities_source_external_unique", () => {
  const err = drizzleWrappedError({ code: "23505", constraint: "partner_opportunities_source_external_unique" });
  assert.equal(isSourceExternalUniqueViolation(err), true);
});

test("does not match: 23505 on a different constraint name -- must not be mislabeled as an import duplicate", () => {
  const err = drizzleWrappedError({ code: "23505", constraint: "users_email_unique" });
  assert.equal(isSourceExternalUniqueViolation(err), false);
});

test("does not match: a check-violation (23514) even if it somehow carried the same constraint name", () => {
  const err = drizzleWrappedError({ code: "23514", constraint: "partner_opportunities_source_external_unique" });
  assert.equal(isSourceExternalUniqueViolation(err), false);
});

test("does not match: 23505 with no constraint field at all", () => {
  const err = drizzleWrappedError({ code: "23505" });
  assert.equal(isSourceExternalUniqueViolation(err), false);
});

test("does not match: an error with no .cause (not a drizzle query-wrapping error)", () => {
  assert.equal(isSourceExternalUniqueViolation(new Error("some unrelated error")), false);
});

test("does not match: a completely unrelated thrown value", () => {
  assert.equal(isSourceExternalUniqueViolation("not even an Error"), false);
  assert.equal(isSourceExternalUniqueViolation(undefined), false);
});
