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

// ---- HubSpot: read-only credential-backed access --------------------------

test("HubSpot metadata describes read-only company/deal lookup and reconciliation", () => {
  const purpose = CONNECTION_PROVIDER_META.hubspot!.purpose;
  assert.match(purpose, /read-only/i);
  assert.match(purpose, /company/i);
  assert.match(purpose, /deal/i);
  assert.match(purpose, /reconciliation/i);
  assert.ok(!/oauth/i.test(purpose));
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

// ---- ConnectionCard generic credential-backed controls --------------------

const cardFnStart = settingsSource.indexOf("function ConnectionCard(");
const cardFnEnd = settingsSource.indexOf("\nfunction ", cardFnStart + 1);
const cardFnSource = settingsSource.slice(cardFnStart, cardFnEnd === -1 ? undefined : cardFnEnd);

test("HubSpot uses the generic credential-backed ConnectionCard controls", () => {
  assert.ok(settingsSource.includes("const SECRET_MANAGEABLE_PROVIDER_TYPES = new Set(['web_search', 'ai', 'hubspot']);"));
  assert.ok(cardFnSource.includes("testMutation.mutate({ id: connection.id })"));
  assert.ok(cardFnSource.includes("Test connection"));
  assert.ok(cardFnSource.includes("Replace"));
  assert.ok(cardFnSource.includes("enabledMutation.mutate"));
  assert.ok(!cardFnSource.includes("meta?.notYetAvailable"));
});

// ---- no internal provider_type caption in the normal UI

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

// ---- Connections vs Metric Setup separation --------------------------------

test("Connections and Metric Setup render as clearly separated sections, not one continuous block", () => {
  const connectionsHeadingIdx = settingsSource.indexOf('<h3 className="text-section-title mb-1">Connections</h3>');
  const metricSetupHeadingIdx = settingsSource.indexOf('<h3 className="text-section-title mb-1">Metric setup</h3>');
  assert.notEqual(connectionsHeadingIdx, -1, "expected a distinct 'Connections' section heading");
  assert.notEqual(metricSetupHeadingIdx, -1, "expected a distinct 'Metric setup' section heading");
  assert.ok(connectionsHeadingIdx < metricSetupHeadingIdx, "expected Connections to precede Metric setup");
});
