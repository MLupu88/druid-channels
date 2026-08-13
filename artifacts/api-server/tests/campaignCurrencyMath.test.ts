// Phase 6: DB-free unit test proving the money math services/campaignService.ts
// reuses from services/kpiService.ts (usdValueOf, convertMoney) never sums
// mixed-currency deal_value rows directly -- it normalizes each row to USD
// first, then converts the USD total once to the display currency. Does not
// touch services/fx.ts's resolveFx (which needs the DB/fx_snapshots table or
// a live rate fetch) -- rate maps here are constructed by hand, matching
// what buildUsdRateMap would have produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usdValueOf, convertMoney } from "../src/services/kpiService";

test("usdValueOf normalizes a non-USD row to USD using the supplied rate, never returning the raw foreign-currency number", () => {
  // 1 USD = 0.92 EUR -> a 92 EUR deal_value is 100 USD.
  const rateByCurrency = new Map([["EUR", 0.92]]);
  const usd = usdValueOf({ dealValue: "92", currency: "EUR" }, rateByCurrency);
  assert.ok(Math.abs(usd - 100) < 0.01, `expected ~100 USD, got ${usd}`);
});

test("usdValueOf treats an unmapped currency as already-USD (rate 1) rather than throwing or silently zeroing", () => {
  const usd = usdValueOf({ dealValue: "250", currency: "USD" }, new Map());
  assert.equal(usd, 250);
});

test("summing multiple currencies via usdValueOf never equals a naive cross-currency addition of the raw deal_value fields", () => {
  const rateByCurrency = new Map([
    ["EUR", 0.92], // 1 USD = 0.92 EUR
    ["GBP", 0.79], // 1 USD = 0.79 GBP
  ]);
  const rows = [
    { dealValue: "100", currency: "USD" }, // 100 USD
    { dealValue: "92", currency: "EUR" }, // 100 USD
    { dealValue: "79", currency: "GBP" }, // 100 USD
  ];
  const usdTotal = rows.reduce((acc, r) => acc + usdValueOf(r, rateByCurrency), 0);
  const naiveSum = rows.reduce((acc, r) => acc + Number(r.dealValue), 0); // 100 + 92 + 79 = 271 -- meaningless across currencies

  assert.ok(Math.abs(usdTotal - 300) < 0.01, `expected ~300 USD total, got ${usdTotal}`);
  assert.notEqual(usdTotal, naiveSum, "the currency-safe USD total must never coincide with the naive raw-number sum");
});

test("convertMoney converts a USD amount to a display currency using usd_to_currency_rate, and passes through null untouched", () => {
  assert.equal(convertMoney(300, 0.92), 276); // 300 USD -> EUR at 0.92
  assert.equal(convertMoney(0, 0.92), 0); // a real zero pipeline stays 0, not null
  assert.equal(convertMoney(null, 0.92), null); // "nothing to convert" stays null, never coerced to 0
});
