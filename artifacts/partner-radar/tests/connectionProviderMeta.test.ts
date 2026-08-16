// Phase 11.6D: pure tests for lib/connection-provider-meta.ts (the display
// mapping itself) plus a small number of source-text structural checks on
// settings.tsx, matching this project's existing convention (see
// tests/commercialCurrencyDisplay.test.ts / commercialPerformanceRoleScope
// .test.ts -- there is no React rendering harness in this project, so a
// deterministic check on the component source is the honest, consistent
// way to guard behavior that can't be asserted as a plain pure-function
// value).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CONNECTION_PROVIDER_META } from "../src/lib/connection-provider-meta";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsSource = readFileSync(path.join(__dirname, "../src/pages/settings.tsx"), "utf-8");

// ---- stable backend identity (must never change) ---------------------------

test("CONNECTION_PROVIDER_META is keyed by exactly the 4 stable backend provider_type values -- never a renamed identity", () => {
  assert.deepEqual(
    Object.keys(CONNECTION_PROVIDER_META).sort(),
    ["ai", "hubspot", "web_reader", "web_search"],
    "provider_type is the stable backend identity (services/connections.ts's DEFAULT_PROVIDERS) -- this display map must be keyed by it exactly, never a display name or anything else",
  );
});

// ---- display mapping --------------------------------------------------------

test("provider_type 'ai' displays as DeepSeek", () => {
  assert.equal(CONNECTION_PROVIDER_META.ai!.displayName, "DeepSeek");
});

test("provider_type 'web_search' displays as Tavily", () => {
  assert.equal(CONNECTION_PROVIDER_META.web_search!.displayName, "Tavily");
});

test("DeepSeek's powers list matches the actual verified call sites, not an aspirational list", () => {
  const powers = CONNECTION_PROVIDER_META.ai!.powers;
  for (const expected of ["Discovery qualification", "Channel Radar qualification", "AI Channel Brief", "PAM Copilot", "Portfolio import"]) {
    assert.ok(powers.some((p) => p.includes(expected)), `expected DeepSeek's powers list to mention "${expected}"`);
  }
});

test("Tavily's powers list matches the actual verified call sites", () => {
  const powers = CONNECTION_PROVIDER_META.web_search!.powers;
  assert.ok(powers.some((p) => p.includes("Discovery")), 'expected Tavily powers to mention Discovery search');
  assert.ok(powers.some((p) => p.includes("DRUID Context")), 'expected Tavily powers to mention DRUID Context ingestion');
});

// ---- Web Reader: hidden, not deleted ---------------------------------------

test("web_reader is marked hidden from the product-facing list", () => {
  assert.equal(CONNECTION_PROVIDER_META.web_reader!.hiddenFromList, true);
});

test("settings.tsx actually filters connections using hiddenFromList before rendering ConnectionCard", () => {
  assert.ok(
    settingsSource.includes("!CONNECTION_PROVIDER_META[c.provider_type]?.hiddenFromList"),
    "expected the Connections list to filter out any provider marked hiddenFromList",
  );
});

// ---- HubSpot: honest, OAuth-oriented, no internal roadmap language --------

test("hubspot is marked not-yet-available (no fake credential/API-key management)", () => {
  assert.equal(CONNECTION_PROVIDER_META.hubspot!.notYetAvailable, true);
  assert.equal(CONNECTION_PROVIDER_META.hubspot!.powers.length, 0);
});

test("HubSpot's product-facing copy mentions OAuth and contains no internal roadmap wording", () => {
  const purpose = CONNECTION_PROVIDER_META.hubspot!.purpose;
  assert.ok(/oauth/i.test(purpose), "expected HubSpot's copy to mention OAuth as the intended connection model");
  for (const forbidden of ["Phase 12", "phase 12", "deferred"]) {
    assert.ok(!purpose.includes(forbidden), `HubSpot's user-facing copy must never mention "${forbidden}"`);
  }
});

test("settings.tsx contains no user-facing 'Phase 12' or 'deferred to Phase' wording anywhere in the Connections surface", () => {
  // Deliberately scans the whole file, not just the HubSpot section --
  // proves no such string was introduced anywhere in this slice. Code
  // comments referencing internal phase numbers are fine (they're never
  // shown to a user); this specifically checks for the phrase as it would
  // appear in rendered copy.
  assert.ok(!settingsSource.includes('"Phase 12"'));
  assert.ok(!settingsSource.includes("deferred to Phase"));
});

// ---- ConnectionCard source, split into its two rendered branches ----------
// (11.6D amendment: HubSpot/notYetAvailable now returns an early, distinct,
// deliberately minimal JSX block -- these two slices let each of the tests
// below assert presence/absence against the RIGHT branch, not the whole
// function, since "Test connection" legitimately appears in one branch and
// must legitimately be absent from the other.)

const cardFnStart = settingsSource.indexOf("function ConnectionCard(");
const cardFnEnd = settingsSource.indexOf("\nfunction ", cardFnStart + 1);
const cardFnSource = settingsSource.slice(cardFnStart, cardFnEnd === -1 ? undefined : cardFnEnd);

const notYetAvailableBranchStart = cardFnSource.indexOf("if (meta?.notYetAvailable) {");
const notYetAvailableBranchEnd = cardFnSource.indexOf("const credentialLine = secretManageable");
assert.ok(notYetAvailableBranchStart !== -1 && notYetAvailableBranchEnd !== -1, "expected to find ConnectionCard's notYetAvailable branch boundaries");
const notYetAvailableBranchSource = cardFnSource.slice(notYetAvailableBranchStart, notYetAvailableBranchEnd);
const generalBranchSource = cardFnSource.slice(notYetAvailableBranchEnd);

test("DeepSeek/Tavily's rendered branch still offers Replace, Test connection, and Enable/Disable", () => {
  assert.ok(generalBranchSource.includes("testMutation.mutate({ id: connection.id })"), "expected Test connection to still work");
  assert.ok(generalBranchSource.includes("Test connection"));
  assert.ok(generalBranchSource.includes("Replace"));
  assert.ok(generalBranchSource.includes("enabledMutation.mutate"), "expected Enable/Disable to still work");
});

test("Replace credential remains gated to only the secret-manageable providers (ai, web_search) -- unchanged", () => {
  assert.ok(settingsSource.includes("const SECRET_MANAGEABLE_PROVIDER_TYPES = new Set(['web_search', 'ai']);"));
});

// ---- 11.6D amendment 1: no internal provider_type caption in the normal UI

test("ConnectionCard no longer renders the raw provider_type as a visible caption", () => {
  assert.ok(
    !cardFnSource.includes('title="Internal provider identity"'),
    "the internal-id caption span must be removed from the normal product-facing card",
  );
  // provider_type is still legitimately READ (icon lookup, secretManageable
  // check, meta lookup) -- this only proves it's never rendered as its own
  // visible text node in the card header.
  assert.ok(!cardFnSource.includes(">{connection.provider_type}<"), "provider_type must never be rendered as its own visible text node");
});

test("CONNECTION_PROVIDER_META remains keyed by the stable provider_type values even though the UI no longer displays them", () => {
  // Same assertion as the stable-identity test above, restated here
  // deliberately -- the whole point of the 11.6D amendment is that hiding
  // provider_type from the UI must not tempt a future edit into keying
  // this map by something else (like displayName) instead.
  assert.deepEqual(Object.keys(CONNECTION_PROVIDER_META).sort(), ["ai", "hubspot", "web_reader", "web_search"]);
});

// ---- 11.6D amendment 2: HubSpot is clearly unavailable, not "testable" ----

test("HubSpot's branch shows a static, product-facing 'Not connected' badge, never the backend-derived ConnectionStatusBadge", () => {
  assert.ok(
    notYetAvailableBranchSource.includes('<Badge variant="outline" className="text-muted-foreground font-normal shrink-0">Not connected</Badge>'),
    "expected a static 'Not connected' badge",
  );
  assert.ok(
    !notYetAvailableBranchSource.includes("<ConnectionStatusBadge"),
    "must never render the backend status/last_error-derived badge for a connection that isn't really connectable yet",
  );
});

test("HubSpot's branch never offers Test connection", () => {
  assert.ok(!notYetAvailableBranchSource.includes("Test connection"));
  assert.ok(!notYetAvailableBranchSource.includes("testMutation.mutate"));
});

test("HubSpot's branch never offers Replace credential", () => {
  assert.ok(!notYetAvailableBranchSource.includes("Replace"));
  assert.ok(!notYetAvailableBranchSource.includes("setReplaceDialogOpen(true)"));
});

test("HubSpot's branch never offers an Enable/Disable switch", () => {
  assert.ok(!notYetAvailableBranchSource.includes("<Switch"));
  assert.ok(!notYetAvailableBranchSource.includes("enabledMutation.mutate"));
});

test("HubSpot's branch never shows credential_env_var / last_tested_at / last_error details", () => {
  assert.ok(!notYetAvailableBranchSource.includes("credential_env_var"));
  assert.ok(!notYetAvailableBranchSource.includes("last_tested_at"));
  assert.ok(!notYetAvailableBranchSource.includes("last_error"));
});

test("HubSpot's branch only ever renders meta.purpose (the OAuth-oriented copy) as its content", () => {
  assert.ok(notYetAvailableBranchSource.includes("{meta.purpose}"));
});

// ---- Connections vs Metric Setup separation --------------------------------

test("Connections and Metric Setup render as clearly separated sections, not one continuous block", () => {
  const connectionsHeadingIdx = settingsSource.indexOf('<h3 className="text-section-title mb-1">Connections</h3>');
  const metricSetupHeadingIdx = settingsSource.indexOf('<h3 className="text-section-title mb-1">Metric setup</h3>');
  assert.notEqual(connectionsHeadingIdx, -1, "expected a distinct 'Connections' section heading");
  assert.notEqual(metricSetupHeadingIdx, -1, "expected a distinct 'Metric setup' section heading");
  assert.ok(connectionsHeadingIdx < metricSetupHeadingIdx, "expected Connections to precede Metric setup");
});
