// Pure unit tests for Stage 6's Radar->company bridge -- no live network,
// DB, or server. Deterministic, exact-name-only, never fuzzy/LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSafeCompanyMatch, pickSafeCompanyMatchDetailed } from "../src/services/radarCompanyBridge";
import type { Company } from "@workspace/db";

function makeCompany(id: string, name: string): Company {
  return {
    id,
    name,
    normalizedName: null,
    domain: `${id}.example`,
    websiteUrl: null,
    country: "Romania",
    headquarters: null,
    employeeBand: null,
    description: null,
    linkedinUrl: null,
    hubspotCompanyId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Company;
}

test("pickSafeCompanyMatch links a signal to the one unambiguous exact-name match", () => {
  const candidates = [makeCompany("a", "UiPath"), makeCompany("b", "Kore.ai")];
  assert.equal(pickSafeCompanyMatch("UiPath", candidates), "a");
});

test("pickSafeCompanyMatch is case/whitespace/suffix insensitive but still exact-normalized", () => {
  const candidates = [makeCompany("a", "UiPath Inc")];
  assert.equal(pickSafeCompanyMatch("  uipath  ", candidates), "a");
});

test("pickSafeCompanyMatch stays unlinked (null) when more than one company shares the normalized name -- never guesses", () => {
  const candidates = [makeCompany("a", "Contoso Ltd"), makeCompany("b", "Contoso GmbH")];
  assert.equal(pickSafeCompanyMatch("Contoso", candidates), null);
});

test("pickSafeCompanyMatch stays unlinked when there is no match at all", () => {
  const candidates = [makeCompany("a", "UiPath")];
  assert.equal(pickSafeCompanyMatch("Completely Different Co", candidates), null);
});

// ---- Phase 10: the `ambiguous` flag alongside company_id -------------------
// requiresValidation (channelRadarEngine.ts) needs to distinguish WHY a
// company_id came back null: genuinely no match (normal, not ambiguous) vs.
// more than one company sharing the name (ambiguous -- a human should
// confirm). company_id's own contract is unchanged by any of this.

test("pickSafeCompanyMatchDetailed: a single unambiguous match -- companyId set, ambiguous false", () => {
  const candidates = [makeCompany("a", "UiPath"), makeCompany("b", "Kore.ai")];
  assert.deepEqual(pickSafeCompanyMatchDetailed("UiPath", candidates), { companyId: "a", ambiguous: false });
});

test("pickSafeCompanyMatchDetailed: zero matches -- companyId null, ambiguous false (never ambiguous just because it's unlisted)", () => {
  const candidates = [makeCompany("a", "UiPath")];
  assert.deepEqual(pickSafeCompanyMatchDetailed("Completely Different Co", candidates), { companyId: null, ambiguous: false });
});

test("pickSafeCompanyMatchDetailed: more than one match -- companyId null, ambiguous true", () => {
  const candidates = [makeCompany("a", "Contoso Ltd"), makeCompany("b", "Contoso GmbH")];
  assert.deepEqual(pickSafeCompanyMatchDetailed("Contoso", candidates), { companyId: null, ambiguous: true });
});

test("pickSafeCompanyMatchDetailed: empty/unnormalizable entity name -- companyId null, ambiguous false", () => {
  const candidates = [makeCompany("a", "UiPath")];
  assert.deepEqual(pickSafeCompanyMatchDetailed("   ", candidates), { companyId: null, ambiguous: false });
});

test("pickSafeCompanyMatch (back-compat wrapper) still returns exactly companyId from the detailed result, unchanged contract", () => {
  const ambiguousCandidates = [makeCompany("a", "Contoso Ltd"), makeCompany("b", "Contoso GmbH")];
  const unambiguousCandidates = [makeCompany("a", "UiPath")];
  assert.equal(pickSafeCompanyMatch("Contoso", ambiguousCandidates), pickSafeCompanyMatchDetailed("Contoso", ambiguousCandidates).companyId);
  assert.equal(pickSafeCompanyMatch("UiPath", unambiguousCandidates), pickSafeCompanyMatchDetailed("UiPath", unambiguousCandidates).companyId);
});
