// Production UX fix: Admin > Connections & data cards reordered on every
// "Test connection" click, and the informational "verification not
// implemented" state -- including for a connection that was never even
// tested yet, and for an optional integration with no credential set --
// rendered as a red failure. Pure-function tests for the deterministic fix
// -- see src/lib/connection-display.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sortConnectionsByDisplayOrder, getConnectionTone, isErrorTone, CONNECTION_DISPLAY_ORDER } from "../src/lib/connection-display";

interface FakeConnection {
  id: string;
  provider_type: string;
  status: string;
  last_tested_at: string | null;
}

function conn(id: string, provider_type: string, status = "unverified", last_tested_at: string | null = null): FakeConnection {
  return { id, provider_type, status, last_tested_at };
}

// ---- ordering (unchanged by this correction) ------------------------------

test("check: deterministic provider order -- AI, Web Search, Web Reader, HubSpot regardless of input order", () => {
  const shuffled = [conn("1", "hubspot"), conn("2", "web_reader"), conn("3", "ai"), conn("4", "web_search")];
  const sorted = sortConnectionsByDisplayOrder(shuffled);
  assert.deepEqual(sorted.map((c) => c.provider_type), ["ai", "web_search", "web_reader", "hubspot"]);
});

test("sorting is stable and reproducible across repeated calls on the same input", () => {
  const input = [conn("1", "hubspot"), conn("2", "ai"), conn("3", "web_search")];
  const first = sortConnectionsByDisplayOrder(input).map((c) => c.id);
  const second = sortConnectionsByDisplayOrder(input).map((c) => c.id);
  assert.deepEqual(first, second);
});

test("check: testing one provider (changing its status/last_tested_at) does not reorder the other cards", () => {
  const before = [conn("ai-1", "ai"), conn("ws-1", "web_search"), conn("wr-1", "web_reader"), conn("hs-1", "hubspot")];
  const sortedBefore = sortConnectionsByDisplayOrder(before).map((c) => c.id);

  const after = before.map((c) => (c.provider_type === "web_search" ? { ...c, status: "unverified", last_tested_at: "2026-08-10T12:00:00.000Z" } : c));
  const sortedAfter = sortConnectionsByDisplayOrder(after).map((c) => c.id);

  assert.deepEqual(sortedAfter, sortedBefore);
});

test("check: provider identity remains correct after state/refetch -- sorting never fabricates or reassigns an id", () => {
  const original = [conn("id-hubspot", "hubspot"), conn("id-ai", "ai")];
  const sorted = sortConnectionsByDisplayOrder(original);
  for (const item of sorted) {
    assert.ok(original.includes(item));
  }
  assert.equal(sorted.find((c) => c.provider_type === "ai")!.id, "id-ai");
  assert.equal(sorted.find((c) => c.provider_type === "hubspot")!.id, "id-hubspot");
});

test("an unrecognized provider_type is appended at the end rather than dropped or crashing", () => {
  const input = [conn("1", "hubspot"), conn("2", "some_future_provider"), conn("3", "ai")];
  const sorted = sortConnectionsByDisplayOrder(input);
  assert.equal(sorted.length, 3);
  assert.equal(sorted[sorted.length - 1]!.provider_type, "some_future_provider");
});

test("CONNECTION_DISPLAY_ORDER is exactly the required fixed order", () => {
  assert.deepEqual(CONNECTION_DISPLAY_ORDER, ["ai", "web_search", "web_reader", "hubspot"]);
});

// ---- status/tone semantics (corrected) ------------------------------------

test("check: AI/Web Search with credential present but never tested (status still not_configured) is 'configured', not an error", () => {
  // The exact production scenario: AI_API_KEY/SEARCH_API_KEY are set, but
  // the row has never been tested, so status is still the seeded default.
  const tone = getConnectionTone("not_configured", true);
  assert.equal(tone, "configured");
  assert.equal(isErrorTone(tone), false);
});

test("check: credential present and tested (status=unverified) is 'configured', not an error -- 'live verification unavailable' is informational", () => {
  const tone = getConnectionTone("unverified", true);
  assert.equal(tone, "configured");
  assert.equal(isErrorTone(tone), false);
});

test("check: Web Reader/HubSpot with no credential configured is neutral 'not_configured', never an error", () => {
  const tone = getConnectionTone("not_configured", false);
  assert.equal(tone, "not_configured");
  assert.equal(isErrorTone(tone), false);
});

test("a real implemented live-check failure (status=error) is always the error tone, regardless of credential presence", () => {
  assert.equal(isErrorTone(getConnectionTone("error", true)), true);
  assert.equal(isErrorTone(getConnectionTone("error", false)), true);
});

test("a successful verified connection is the connected tone, not an error", () => {
  assert.equal(isErrorTone(getConnectionTone("connected", true)), false);
});

test("Do NOT treat every not_configured provider as a red error -- only a real 'error' status is ever the error tone", () => {
  const allNonErrorStatuses = ["not_configured", "unverified", "connected"];
  for (const status of allNonErrorStatuses) {
    for (const hasCredential of [true, false]) {
      assert.equal(isErrorTone(getConnectionTone(status, hasCredential)), false, `status=${status} hasCredential=${hasCredential} must not be an error`);
    }
  }
});

// ---- Phase 11.5B: enabled=false -> 'disabled' tone ------------------------

test("check: enabled=false is the 'disabled' tone, regardless of status or credential presence", () => {
  assert.equal(getConnectionTone("connected", true, false), "disabled");
  assert.equal(getConnectionTone("error", true, false), "disabled");
  assert.equal(getConnectionTone("not_configured", false, false), "disabled");
});

test("check: 'disabled' is never treated as an error tone", () => {
  assert.equal(isErrorTone(getConnectionTone("error", true, false)), false);
});

test("check: enabled defaults to true when omitted, so every existing call site (2-arg) is unaffected by the enabled param", () => {
  assert.equal(getConnectionTone("connected", true), "connected");
  assert.equal(getConnectionTone("not_configured", false), "not_configured");
});

test("check: enabled=true (explicit) behaves identically to the default", () => {
  assert.equal(getConnectionTone("not_configured", true, true), "configured");
  assert.equal(getConnectionTone("error", true, true), "error");
});
