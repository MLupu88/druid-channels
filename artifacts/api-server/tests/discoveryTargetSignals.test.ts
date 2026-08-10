// Pure unit tests for target_signals influencing live Discovery -- no live
// network, DB, or server. buildAutomaticQueries/buildPartnerSearchCriteria
// are pure functions (plain config/territory objects in, strings/criteria
// out), so these are tested directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutomaticQueries, buildPartnerSearchCriteria, mapTargetSignalsToTypes } from "../src/services/discoveryEngine";
import type { ScanConfig, Territory } from "@workspace/db";

function baseConfig(overrides: Partial<ScanConfig> = {}): ScanConfig {
  return {
    id: "config-1",
    territoryId: "territory-1",
    name: "Test config",
    searchQueries: [],
    partnerTypes: ["System Integrator"],
    industries: ["Banking"],
    technologies: ["Microsoft"],
    excludedDomains: [],
    targetSignals: [],
    maxResults: 25,
    minChecksRequired: 3,
    recencyWindowDays: 90,
    active: true,
    ...overrides,
  } as ScanConfig;
}

const territory: Territory = {
  id: "territory-1",
  name: "UK & Ireland",
  ownerUserId: null,
  countries: ["United Kingdom", "Ireland"],
  languages: [],
} as Territory;

test("mapTargetSignalsToTypes maps known UI ids to the canonical signal_type taxonomy, dropping unmapped ids", () => {
  const result = mapTargetSignalsToTypes(["partnerships", "ai_moves", "rfps", "events", "customer_wins", "new_partners"]);
  assert.deepEqual(result, ["partnership", "ai_investment", "tender", "event", "enterprise_access"]);
});

test("selected target signals influence generated search queries without increasing query count", () => {
  const withoutSignals = buildAutomaticQueries(baseConfig({ targetSignals: [] }), territory);
  const withSignals = buildAutomaticQueries(baseConfig({ targetSignals: ["partnerships", "rfps"] }), territory);

  assert.equal(withSignals.length, withoutSignals.length); // same query count -- no extra search calls per signal
  assert.notDeepEqual(withSignals, withoutSignals); // but the queries themselves are different
  const joined = withSignals.join(" | ");
  assert.ok(joined.includes("partner program") || joined.includes("tender contract award"), "expected a signal phrase to appear in at least one query");
});

test("target signals alone (no tech/partner type/industry) still produce queries, not an empty list", () => {
  const queries = buildAutomaticQueries(
    baseConfig({ partnerTypes: [], industries: [], technologies: [], targetSignals: ["partnerships", "events"] }),
    territory,
  );
  assert.ok(queries.length > 0);
});

test("buildPartnerSearchCriteria includes the mapped target signal types in the qualification context", () => {
  const criteria = buildPartnerSearchCriteria(baseConfig({ targetSignals: ["ai_moves", "events"] }), territory);
  assert.deepEqual(criteria.targetSignalTypes, ["ai_investment", "event"]);
});

test("no target signals configured produces an empty targetSignalTypes list, not a fabricated default", () => {
  const criteria = buildPartnerSearchCriteria(baseConfig({ targetSignals: [] }), territory);
  assert.deepEqual(criteria.targetSignalTypes, []);
});
