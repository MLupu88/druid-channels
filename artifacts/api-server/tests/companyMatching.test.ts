// Pure unit tests for Stage 6 deterministic company matching and date
// precision classification -- no live network, DB, or server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyName, classifyDatePhrase, matchCompanyDeterministic } from "../src/services/companyMatchingService";
import type { Company } from "@workspace/db";

function makeCompany(overrides: Partial<Company>): Company {
  return {
    id: overrides.id ?? "id-1",
    name: overrides.name ?? "Acme Ltd",
    normalizedName: overrides.normalizedName ?? null,
    domain: overrides.domain ?? "acme.com",
    websiteUrl: null,
    country: overrides.country ?? "Romania",
    headquarters: null,
    employeeBand: null,
    description: null,
    linkedinUrl: null,
    hubspotCompanyId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Company;
}

test("normalizeCompanyName strips legal suffixes and case/punctuation", () => {
  assert.equal(normalizeCompanyName("Acme Ltd."), "acme");
  assert.equal(normalizeCompanyName("Acme Systems, Inc"), "acme systems");
  assert.equal(normalizeCompanyName("ACME"), "acme");
});

test("classifyDatePhrase: exact ISO date", () => {
  assert.deepEqual(classifyDatePhrase("2026-01-15"), { value: "2026-01-15", precision: "exact_date" });
});

test("classifyDatePhrase: quarter phrase", () => {
  assert.deepEqual(classifyDatePhrase("Q1 2026"), { value: "2026-01-01", precision: "quarter" });
  assert.deepEqual(classifyDatePhrase("Q3-2026"), { value: "2026-07-01", precision: "quarter" });
});

test("classifyDatePhrase: month phrase", () => {
  assert.deepEqual(classifyDatePhrase("March 2026"), { value: "2026-03-01", precision: "month" });
});

test("classifyDatePhrase: bare/since year, never fabricated to a fake exact date", () => {
  assert.deepEqual(classifyDatePhrase("since 2024"), { value: "2024-01-01", precision: "year" });
  assert.deepEqual(classifyDatePhrase("2024"), { value: "2024-01-01", precision: "year" });
});

test("classifyDatePhrase: unrecognized/empty phrase stays unknown, never guessed", () => {
  assert.deepEqual(classifyDatePhrase("a while back"), { value: null, precision: "unknown" });
  assert.deepEqual(classifyDatePhrase(null), { value: null, precision: "unknown" });
  assert.deepEqual(classifyDatePhrase(""), { value: null, precision: "unknown" });
});

test("matchCompanyDeterministic: domain match disambiguated by country", () => {
  const candidates = [makeCompany({ id: "ro", domain: "acme.com", country: "Romania" }), makeCompany({ id: "uk", domain: "acme.com", country: "United Kingdom" })];
  const result = matchCompanyDeterministic({ name: "Acme", domain: "acme.com", country: "Romania" }, candidates, []);
  assert.equal(result.status, "matched_existing_company");
  assert.equal(result.matchedCompanyId, "ro");
});

test("matchCompanyDeterministic: name match disambiguated by country when no domain given", () => {
  const candidates = [makeCompany({ id: "ro", name: "Contoso Ltd", country: "Romania" }), makeCompany({ id: "de", name: "Contoso GmbH", country: "Germany" })];
  const result = matchCompanyDeterministic({ name: "Contoso", domain: null, country: "Germany" }, [], candidates);
  assert.equal(result.status, "matched_existing_company");
  assert.equal(result.matchedCompanyId, "de");
});

test("matchCompanyDeterministic: unambiguous single domain match even without country", () => {
  const candidates = [makeCompany({ id: "only-one", domain: "uniquecorp.com" })];
  const result = matchCompanyDeterministic({ name: "UniqueCorp", domain: "uniquecorp.com", country: null }, candidates, candidates);
  assert.equal(result.status, "matched_existing_company");
  assert.equal(result.matchedCompanyId, "only-one");
});

test("matchCompanyDeterministic: ambiguous candidates (no country to disambiguate) -> possible_duplicate, never guessed", () => {
  const candidates = [makeCompany({ id: "a", name: "Contoso Ltd", country: "Romania" }), makeCompany({ id: "b", name: "Contoso GmbH", country: "Germany" })];
  const result = matchCompanyDeterministic({ name: "Contoso", domain: null, country: null }, [], candidates);
  assert.equal(result.status, "possible_duplicate");
  assert.equal(result.matchedCompanyId, null);
});

test("matchCompanyDeterministic: no candidates at all -> ready to create", () => {
  const result = matchCompanyDeterministic({ name: "Brand New Co", domain: null, country: "France" }, [], []);
  assert.equal(result.status, "ready");
});

test("matchCompanyDeterministic: no usable company name -> invalid", () => {
  const result = matchCompanyDeterministic({ name: "", domain: null, country: null }, [], []);
  assert.equal(result.status, "invalid");
});
