// Phase 11.6E: structural/pure tests for the DRUID Context "Create fact
// from source" UX correction (src/pages/settings.tsx's
// CreateFactFromSourceDialog). Same source-text-boundary convention as
// tests/connectionProviderMeta.test.ts / commercialCurrencyDisplay.test.ts
// -- this project has no React rendering harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsSource = readFileSync(path.join(__dirname, "../src/pages/settings.tsx"), "utf-8");

const dialogStart = settingsSource.indexOf("function CreateFactFromSourceDialog(");
const dialogEnd = settingsSource.indexOf("\nfunction ", dialogStart + 1);
const dialogSource = settingsSource.slice(dialogStart, dialogEnd === -1 ? undefined : dialogEnd);

test("CreateFactFromSourceDialog exists and was found for slicing", () => {
  assert.notEqual(dialogStart, -1);
});

// ---- fact field is never prefilled with raw source content ----------------

test("the fact field starts empty -- never prefilled with source.extracted_text", () => {
  // Checks the actual initializer expression, not bare substring presence
  // -- this file's own explanatory comment legitimately mentions the old
  // pattern by name when describing what changed.
  assert.ok(!dialogSource.includes("useState(source.extracted_text"), "the old raw-text prefill must be gone from factText's initializer");
  assert.ok(dialogSource.includes("const [factText, setFactText] = useState('')"), "expected factText to initialize from an empty string");
});

test("no automatic LLM fact generation was introduced -- no AI/DeepSeek call anywhere in this dialog", () => {
  for (const forbidden of ["deepseek", "DeepSeek", "generateFact", "aiProvider", "useGetAiChannelBrief"]) {
    assert.ok(!dialogSource.includes(forbidden), `CreateFactFromSourceDialog must never reference "${forbidden}"`);
  }
});

// ---- source content remains visible, read-only, and clearly distinct -----

test("the full source excerpt (extracted_text) remains visible in the dialog, read-only", () => {
  assert.ok(dialogSource.includes("{source.extracted_text}"), "expected the full source text to still be shown, not hidden");
  // Read-only: appears as a <p>, never inside an <Input>/<Textarea> bound
  // to editable local state.
  assert.ok(!dialogSource.includes("value={source.extracted_text}"), "source text must never be bound as an editable field's value");
});

test("source URL/domain provenance is shown in the dialog", () => {
  assert.ok(dialogSource.includes("source.source_url"), "expected the real source URL to be shown");
  assert.ok(dialogSource.includes("sourceDomainLabel(source.source_url)"), "expected a readable domain label derived from the real URL");
});

test("SOURCE and FACT are visually distinct sections in the dialog markup", () => {
  const sourceLabelIdx = dialogSource.indexOf(">Source<");
  const factFieldIdx = dialogSource.indexOf('htmlFor="source-fact-text"');
  assert.notEqual(sourceLabelIdx, -1, "expected a distinct 'Source' section label");
  assert.notEqual(factFieldIdx, -1, "expected the Fact field");
  assert.ok(sourceLabelIdx < factFieldIdx, "expected Source to be presented before the Fact field");
});

// ---- Save still creates an unverified fact; Verify stays separate --------

test("creating a fact from a source still goes through useCreateFactFromDruidContextSource (unverified by construction)", () => {
  assert.ok(dialogSource.includes("useCreateFactFromDruidContextSource"));
  assert.ok(dialogSource.includes("It is unverified"), "expected the success toast to still say the fact is unverified");
});

test("Verify is not offered anywhere inside CreateFactFromSourceDialog -- it remains a separate action in DRUID facts", () => {
  assert.ok(!dialogSource.includes("useVerifyDruidFact"), "verification hook must never be reachable from the source-creation dialog");
  assert.ok(!dialogSource.includes("verifyMutation"), "no verify mutation/button may exist inside this dialog");
});

test("useVerifyDruidFact is still wired up elsewhere (DruidFactsSection) as its own explicit action", () => {
  assert.ok(settingsSource.includes("const verifyMutation = useVerifyDruidFact("));
  assert.ok(settingsSource.includes("onClick={() => verifyMutation.mutate({ id: f.id })}"));
});

// ---- section separation / hierarchy ----------------------------------------

test("DRUID facts and Source material render as clearly separated sections", () => {
  const factsHeadingIdx = settingsSource.indexOf('<h3 className="text-section-title">DRUID facts</h3>');
  const sourceHeadingIdx = settingsSource.indexOf('<h3 className="text-section-title">Source material</h3>');
  assert.notEqual(factsHeadingIdx, -1);
  assert.notEqual(sourceHeadingIdx, -1);
  assert.ok(factsHeadingIdx < sourceHeadingIdx, "expected DRUID facts to precede Source material");
});
