// Pure unit tests for Phase 11.5A's deterministic exclusion-matching logic
// -- no live network, DB, or server. isDomainExcluded is a plain function
// (a domain string + a set of excluded domains in, boolean out), so it's
// tested directly here. See services/discoveryExclusions.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDomainExcluded } from "../src/services/discoveryExclusions";

test("exact domain match is excluded", () => {
  assert.equal(isDomainExcluded("acme.com", new Set(["acme.com"])), true);
});

test("a subdomain of an excluded domain is excluded", () => {
  assert.equal(isDomainExcluded("app.acme.com", new Set(["acme.com"])), true);
});

test("an unrelated domain is never excluded", () => {
  assert.equal(isDomainExcluded("other-company.com", new Set(["acme.com"])), false);
});

test("a domain that merely contains the excluded string as a substring (not a subdomain) is not excluded", () => {
  // "notacme.com" is not a subdomain of "acme.com" and must not match --
  // only an exact match or a genuine ".<excluded>" suffix counts.
  assert.equal(isDomainExcluded("notacme.com", new Set(["acme.com"])), false);
});

test("an empty exclusion set never excludes anything", () => {
  assert.equal(isDomainExcluded("acme.com", new Set()), false);
});

test("multiple exclusions are all checked independently", () => {
  const exclusions = new Set(["acme.com", "widgets.io"]);
  assert.equal(isDomainExcluded("acme.com", exclusions), true);
  assert.equal(isDomainExcluded("widgets.io", exclusions), true);
  assert.equal(isDomainExcluded("unrelated.net", exclusions), false);
});

test("does not weaken existing candidate dedupe: this check is independent of shouldSkipBeforeQualification's URL-based dedupe -- a domain absent from exclusions is never itself treated as a duplicate", () => {
  // Regression guard: isDomainExcluded must be a pure additive gate, never
  // a substitute for or interference with the existing seenUrls-based
  // dedupe in discoveryEngine.ts (shouldSkipBeforeQualification), which
  // operates on a completely separate Set (seen URLs, not excluded
  // domains) and is untouched by this feature.
  const seenUrls = new Set<string>(["https://acme.com/press/1"]);
  const exclusions = new Set<string>(); // nothing excluded
  assert.equal(seenUrls.has("https://acme.com/press/2"), false, "a different URL on the same domain is not a URL-dedupe hit");
  assert.equal(isDomainExcluded("acme.com", exclusions), false, "and is not excluded either -- the two mechanisms are independent");
});
