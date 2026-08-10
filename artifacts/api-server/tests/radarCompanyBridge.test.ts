// Pure unit tests for Stage 6's Radar->company bridge -- no live network,
// DB, or server. Deterministic, exact-name-only, never fuzzy/LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSafeCompanyMatch } from "../src/services/radarCompanyBridge";
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
