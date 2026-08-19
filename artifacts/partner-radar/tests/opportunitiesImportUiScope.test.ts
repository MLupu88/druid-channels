// Phase 5B-3: structural regression guard for the historical opportunity
// import entry point and route. Same convention as
// tests/opportunitiesUiScope.test.ts -- this project has no React rendering
// harness, so these are plain node:test source-text checks, not rendered
// -DOM assertions. Server-side authz (GET /users, POST /opportunities
// scoping) is exercised separately in artifacts/api-server/tests/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(path.join(__dirname, "../src/App.tsx"), "utf-8");
const opportunitiesSource = readFileSync(path.join(__dirname, "../src/pages/opportunities.tsx"), "utf-8");
const importPageSource = readFileSync(path.join(__dirname, "../src/pages/opportunities-import.tsx"), "utf-8");

test("the /opportunities/import route is wrapped in Guarded allow={isGlobalUser} -- a PAM must never reach it, even by direct navigation", () => {
  const routeIndex = appSource.indexOf('path="/opportunities/import"');
  assert.notEqual(routeIndex, -1, "expected an /opportunities/import route");
  const routeBlock = appSource.slice(routeIndex, routeIndex + 200);
  assert.ok(routeBlock.includes("Guarded allow={isGlobalUser}"), "the import route must be gated behind Guarded allow={isGlobalUser}");
});

test("the import entry-point button on the Opportunities list only renders for isGlobalUser, never for canMutate (PAM)", () => {
  const buttonIndex = opportunitiesSource.indexOf("button-import-opportunities");
  assert.notEqual(buttonIndex, -1, "expected an import entry-point button");
  const precedingSlice = opportunitiesSource.slice(Math.max(0, buttonIndex - 200), buttonIndex);
  assert.ok(precedingSlice.includes("isGlobalUser &&"), "the import button must be gated behind isGlobalUser, not canMutate");
});

test("the import button links to /opportunities/import, inside the isGlobalUser-gated block", () => {
  const testidIndex = opportunitiesSource.indexOf("button-import-opportunities");
  assert.notEqual(testidIndex, -1, "expected an import entry-point button");

  // Bounded by real code structure, not an arbitrary character count: the
  // nearest preceding {isGlobalUser && ( gate that actually wraps this
  // button (lastIndexOf searching backward from testidIndex skips the
  // unrelated "isGlobalUser &&" substrings elsewhere in this file, e.g.
  // "!isGlobalUser && territoriesLoaded" and the later territory-filter
  // gate, since neither matches the exact "{isGlobalUser && (" JSX-gate
  // pattern at this position).
  const gateIndex = opportunitiesSource.lastIndexOf("{isGlobalUser && (", testidIndex);
  assert.notEqual(gateIndex, -1, "expected the import button to sit inside an {isGlobalUser && (...)} block");

  // The complete opening <Button ...> tag carrying this data-testid --
  // found via its own start/end markers (nearest preceding "<Button" and
  // that tag's own closing ">"), never a fixed-length slice off the
  // testid's position.
  const buttonTagStart = opportunitiesSource.lastIndexOf("<Button", testidIndex);
  assert.notEqual(buttonTagStart, -1, "expected a <Button opening tag preceding the data-testid");
  assert.ok(buttonTagStart >= gateIndex, "the <Button must be inside the isGlobalUser-gated block");
  const buttonTagEnd = opportunitiesSource.indexOf(">", buttonTagStart);
  assert.notEqual(buttonTagEnd, -1, "expected the <Button opening tag to close");
  const buttonTag = opportunitiesSource.slice(buttonTagStart, buttonTagEnd + 1);
  assert.ok(buttonTag.includes('data-testid="button-import-opportunities"'), "expected the complete Button opening tag to carry this data-testid");

  // The nearest wrapping <Link ...> tag between the gate and the Button,
  // located and closed the same way.
  const linkTagStart = opportunitiesSource.lastIndexOf("<Link", buttonTagStart);
  assert.notEqual(linkTagStart, -1, "expected a <Link wrapping the import button");
  assert.ok(linkTagStart >= gateIndex, "the wrapping <Link must be inside the isGlobalUser-gated block");
  const linkTagEnd = opportunitiesSource.indexOf(">", linkTagStart);
  assert.notEqual(linkTagEnd, -1, "expected the <Link opening tag to close");
  const linkTag = opportunitiesSource.slice(linkTagStart, linkTagEnd + 1);
  assert.ok(linkTag.includes('href="/opportunities/import"'), "the Link wrapping the import button must point at /opportunities/import");
});

test("the import page never fetches or references PAM roster data for anything but resolving pam_email/territory (no reassignment UI)", () => {
  assert.ok(!/reassign/i.test(importPageSource), "the import page must not implement any opportunity-reassignment UI/handler");
});

test("the CSV contract has no source_system column -- the importer decides it, a CSV row can never override it", () => {
  const libSource = readFileSync(path.join(__dirname, "../src/lib/opportunity-import.ts"), "utf-8");
  assert.ok(!/'source_system'|"source_system"/.test(libSource.split("IMPORT_CSV_COLUMNS = [")[1]!.split("] as const")[0]!), "source_system must not be a CSV column");
  assert.ok(libSource.includes("source_system: 'import'"), "the importer must hardcode source_system to 'import' when building the create payload");
});

test("the confirm step submits only Ready rows, sequentially, and records imported/duplicate/failed per row", () => {
  assert.ok(importPageSource.includes("readyRows"), "expected the confirm handler to operate on the Ready-only row list");
  assert.ok(importPageSource.includes("for (const row of readyRows)"), "rows must be submitted via a sequential loop, never Promise.all/concurrent dispatch");
  assert.ok(!/Promise\.all/.test(importPageSource), "the import page must never fire opportunity creation requests concurrently");
  assert.ok(importPageSource.includes("'imported'") && importPageSource.includes("'duplicate'") && importPageSource.includes("'failed'"), "the result must distinguish imported/duplicate/failed outcomes");
});

test("a 409 conflict on confirm is treated as a duplicate outcome, not a generic failure", () => {
  const confirmIndex = importPageSource.indexOf("const handleConfirm");
  const confirmBlock = importPageSource.slice(confirmIndex, confirmIndex + 1200);
  assert.ok(confirmBlock.includes("err.status === 409"), "a 409 from POST /opportunities must be distinguished from other failures");
});

test("HubSpot reconciliation uses narrow backend helpers and no generic column-mapping UI", () => {
  assert.ok(importPageSource.includes("reconcileOpportunityImport"));
  assert.ok(importPageSource.includes("ensureOpportunityImportCompany"));
  assert.ok(!/column.?mapp/i.test(importPageSource), "no arbitrary/saved column-mapping UI");
});

test("the CSV contract's required columns are surfaced as helper copy on the import page", () => {
  assert.ok(importPageSource.includes("IMPORT_CSV_COLUMNS.join"), "the page must display the required column list to the user");
});

test("this import is only reachable from the Opportunities page's Head/Admin button or a direct URL -- no sidebar nav entry is added", () => {
  const layoutSource = readFileSync(path.join(__dirname, "../src/components/layout.tsx"), "utf-8");
  assert.ok(!layoutSource.includes("/opportunities/import"), "the import route must not get its own sidebar nav item (same convention as /portfolio/import)");
});
