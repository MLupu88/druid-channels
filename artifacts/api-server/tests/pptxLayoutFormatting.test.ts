// Phase 8: characterization test for the pure formatting/branding functions
// extracted from services/pptxReport.ts into src/lib/pptxLayout.ts. Written
// BEFORE the extraction and re-run AFTER it (per the Phase 8 "characterize,
// then extract" instruction) -- asserts the exact same output the original
// inline pptxReport.ts implementations produced, so the extraction is
// provably behavior-preserving for the quarterly deck and safe to reuse for
// the new management deck.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCount,
  formatMoney,
  formatValue,
  formatTrend,
  formatStatus,
  formatFreshness,
  fxDescriptionLine,
  dataStatusLabel,
  dataStatusColor,
  BRAND_NAVY,
  BRAND_GREY,
  STATUS_COLOR,
  FOOTER_LABEL,
} from "../src/lib/pptxLayout";
import type { FxInfo } from "../src/services/fx";

test("formatCount formats with thousands separators, en-US, no decimals", () => {
  assert.equal(formatCount(1234), "1,234");
  assert.equal(formatCount(0), "0");
});

test("formatCount renders null as an em-dash placeholder, never a fabricated 0", () => {
  assert.equal(formatCount(null), "--");
});

test("formatMoney formats as whole-unit currency, en-US locale, no decimals", () => {
  assert.equal(formatMoney(125000, "USD"), "$125,000");
  assert.equal(formatMoney(125000, "EUR"), "€125,000");
  assert.equal(formatMoney(125000, "GBP"), "£125,000");
});

test("formatMoney renders null as an em-dash placeholder", () => {
  assert.equal(formatMoney(null, "USD"), "--");
});

test("formatValue dispatches to money vs count formatting by the explicit isMoney flag", () => {
  assert.equal(formatValue(5000, true, "USD"), "$5,000");
  assert.equal(formatValue(5000, false, "USD"), "5,000");
});

test("formatTrend title-cases a lowercase trend value", () => {
  assert.equal(formatTrend("up"), "Up");
  assert.equal(formatTrend("down"), "Down");
  assert.equal(formatTrend("flat"), "Flat");
});

test("formatTrend renders null as an em-dash placeholder", () => {
  assert.equal(formatTrend(null), "--");
});

test("formatStatus title-cases each underscore-separated word", () => {
  assert.equal(formatStatus("on_track"), "On Track");
  assert.equal(formatStatus("green"), "Green");
});

test("formatStatus renders null as an em-dash placeholder", () => {
  assert.equal(formatStatus(null), "--");
});

test("formatFreshness renders a deterministic UTC date + time regardless of server locale", () => {
  assert.equal(formatFreshness("2026-07-13T14:32:00.000Z"), "2026-07-13 14:32 UTC");
});

test("dataStatusLabel maps every DataStatus value to its display label", () => {
  assert.equal(dataStatusLabel("CONNECTED"), "Connected");
  assert.equal(dataStatusLabel("MANUAL"), "Manual");
  assert.equal(dataStatusLabel("DEMO"), "Demo data");
  assert.equal(dataStatusLabel("NOT_CONNECTED"), "Not connected");
});

test("dataStatusColor flags DEMO amber and NOT_CONNECTED grey, everything else green", () => {
  assert.equal(dataStatusColor("DEMO"), "D19A0A");
  assert.equal(dataStatusColor("NOT_CONNECTED"), BRAND_GREY);
  assert.equal(dataStatusColor("CONNECTED"), "1E9E5A");
});

test("fxDescriptionLine never uses the word 'live' -- locked wording, a daily reference rate only", () => {
  const fx: FxInfo = { currency: "EUR", usd_to_currency_rate: 0.92, as_of: "2026-07-10", source: "frankfurter.app", stale: false };
  const line = fxDescriptionLine(fx);
  assert.doesNotMatch(line, /\blive\b/i);
  assert.match(line, /Frankfurter/);
  assert.match(line, /0\.9200/);
});

test("fxDescriptionLine states no conversion was applied for USD", () => {
  const fx: FxInfo = { currency: "USD", usd_to_currency_rate: 1, as_of: null, source: null, stale: false };
  assert.match(fxDescriptionLine(fx), /no conversion was applied/);
});

test("fxDescriptionLine surfaces staleness explicitly rather than silently reusing an old rate", () => {
  const fx: FxInfo = { currency: "GBP", usd_to_currency_rate: 0.79, as_of: "2026-07-01", source: "frankfurter.app", stale: true };
  assert.match(fxDescriptionLine(fx), /marked stale/);
});

test("brand constants used by both the quarterly and management decks are stable", () => {
  assert.equal(BRAND_NAVY, "0F2A4A");
  assert.equal(STATUS_COLOR.green, "1E9E5A");
  assert.equal(STATUS_COLOR.red, "D14343");
  assert.equal(FOOTER_LABEL, "DRUID · Channels and alliances");
});
