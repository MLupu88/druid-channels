// Pure unit tests for Phase 12 PAM name resolution (get_pam_overview's
// pam_name argument) -- no live network, DB, or server. Mirrors the exact
// bug this exists to fix: Aniri could not resolve "Denny" / "denny" /
// "Denny Morais" to a PAM and had to ask the user for territory/partners
// instead of just answering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePamByName } from "../src/services/pamResolution";
import type { User } from "@workspace/db";

function makePam(overrides: Partial<User> & { id: string; name: string; email: string }): User {
  return {
    role: "pam",
    territory: null,
    locationLabel: null,
    timezone: null,
    active: true,
    passwordHash: null,
    createdAt: new Date(),
    ...overrides,
  } as User;
}

const denny = makePam({ id: "u-denny", name: "Denny Morais", email: "denny.morais@druidai.com" });
const james = makePam({ id: "u-james", name: "James Bradley", email: "james.bradley@druidai.com" });
const roster = [denny, james];

test("exact full name, case-insensitive, resolves uniquely", () => {
  assert.deepEqual(resolvePamByName("Denny Morais", roster), { status: "found", user: denny });
  assert.deepEqual(resolvePamByName("denny morais", roster), { status: "found", user: denny });
  assert.deepEqual(resolvePamByName("DENNY MORAIS", roster), { status: "found", user: denny });
});

test("first name alone resolves uniquely when unambiguous -- the exact bug this fixes: never ask for territory when the name already resolves", () => {
  assert.deepEqual(resolvePamByName("Denny", roster), { status: "found", user: denny });
  assert.deepEqual(resolvePamByName("denny", roster), { status: "found", user: denny });
});

test("exact email match resolves uniquely", () => {
  assert.deepEqual(resolvePamByName("denny.morais@druidai.com", roster), { status: "found", user: denny });
  assert.deepEqual(resolvePamByName("DENNY.MORAIS@DRUIDAI.COM", roster), { status: "found", user: denny });
});

test("unknown name resolves to not_found", () => {
  assert.deepEqual(resolvePamByName("Someone Else", roster), { status: "not_found" });
  assert.deepEqual(resolvePamByName("", roster), { status: "not_found" });
  assert.deepEqual(resolvePamByName("   ", roster), { status: "not_found" });
});

test("two PAMs sharing a first name are reported as a bounded ambiguity, never guessed", () => {
  const dennySmith = makePam({ id: "u-denny-2", name: "Denny Smith", email: "denny.smith@druidai.com" });
  const tworoster = [denny, dennySmith, james];
  const result = resolvePamByName("Denny", tworoster);
  assert.equal(result.status, "ambiguous");
  if (result.status === "ambiguous") {
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(
      result.candidates.map((c) => c.id).sort(),
      [denny.id, dennySmith.id].sort(),
    );
  }
});

test("an exact full-name match wins even when a looser tier would also have matched -- most-specific tier never falls through", () => {
  // "Denny Morais" substring-matches both denny.name and would ALSO
  // substring-match a hypothetical "Old Denny Morais Archive" row, but the
  // exact-name tier resolves first and stops there.
  const archived = makePam({ id: "u-archived", name: "Old Denny Morais Archive", email: "archived@druidai.com" });
  const result = resolvePamByName("Denny Morais", [denny, archived]);
  assert.deepEqual(result, { status: "found", user: denny });
});

test("substring match resolves when nothing more specific matched, but stays ambiguous if multiple names contain it", () => {
  const single = resolvePamByName("Morais", [denny, james]);
  assert.deepEqual(single, { status: "found", user: denny });

  const moraisTwo = makePam({ id: "u-morais-2", name: "Ana Morais", email: "ana.morais@druidai.com" });
  const ambiguous = resolvePamByName("Morais", [denny, moraisTwo]);
  assert.equal(ambiguous.status, "ambiguous");
});

test("candidate list is bounded even with many matches", () => {
  const many: User[] = Array.from({ length: 25 }, (_, i) => makePam({ id: `u-${i}`, name: `Denny Clone ${i}`, email: `denny${i}@druidai.com` }));
  const result = resolvePamByName("Denny", many);
  assert.equal(result.status, "ambiguous");
  if (result.status === "ambiguous") {
    assert.ok(result.candidates.length <= 10, "ambiguity candidates must be bounded, never a full roster dump");
  }
});

test("an inactive PAM still resolves by name -- this function does not filter on active; callers decide roster scope", () => {
  const inactive = makePam({ id: "u-inactive", name: "Old Pam", email: "old.pam@druidai.com", active: false });
  assert.deepEqual(resolvePamByName("Old Pam", [inactive]), { status: "found", user: inactive });
});
