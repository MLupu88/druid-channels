// 5B-R hotfix: Settings multi-value inputs (partner types, industries,
// technologies, excluded domains, Radar monitored entities, search
// queries) used to parse on every keystroke and feed the parsed array
// straight back into the controlled input, which lost a trailing comma or
// space the instant it was typed. Parsing must only ever happen at the
// save/commit boundary -- these are pure unit tests for that boundary
// function itself. No React rendering, no DOM: the fix that keeps the
// *raw* text in a separate state while editing (see settings.tsx's
// localPartnerTypes/localIndustries/localTechnologies/localExcludedDomains/
// localSearchQueries/localMonitoredEntities) is a structural property of
// the component -- these values are simply never fed through parse* until
// handleSave -- and is verified in a real browser (see PR notes), not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMultiValueInput,
  formatMultiValueInput,
  parseLineDelimitedInput,
  formatLineDelimitedInput,
} from "../src/lib/multi-value-input";

// ---- parseMultiValueInput (comma-delimited: partner types, industries,
// technologies, excluded domains, Radar monitored entities) ---------------

test("check: a trailing comma does not produce a trailing empty entry", () => {
  assert.deepEqual(parseMultiValueInput("System Integrator,"), ["System Integrator"]);
});

test("check: a trailing space-only segment is dropped, not kept as an empty string", () => {
  assert.deepEqual(parseMultiValueInput("System Integrator, "), ["System Integrator"]);
});

test("check: a multi-word value is preserved intact, not split on the internal space", () => {
  assert.deepEqual(parseMultiValueInput("System Integrator"), ["System Integrator"]);
});

test("check: multiple comma-separated values parse correctly at save", () => {
  assert.deepEqual(parseMultiValueInput("System Integrator, Consulting, MSP"), ["System Integrator", "Consulting", "MSP"]);
});

test("check: irregular spacing around commas is normalized", () => {
  assert.deepEqual(parseMultiValueInput("  SI ,Consulting  ,   MSP  "), ["SI", "Consulting", "MSP"]);
});

test("check: an empty/whitespace-only string parses to an empty array, not [\"\"]", () => {
  assert.deepEqual(parseMultiValueInput(""), []);
  assert.deepEqual(parseMultiValueInput("   "), []);
});

test("check: consecutive commas (empty segments) never produce empty entries", () => {
  assert.deepEqual(parseMultiValueInput("SI,,MSP"), ["SI", "MSP"]);
});

test("same parse function backs both Partner types/Industries/Technologies/Excluded domains and Radar monitored entities -- identical behavior for all", () => {
  const raw = "Microsoft, UiPath, Kore.ai";
  assert.deepEqual(parseMultiValueInput(raw), ["Microsoft", "UiPath", "Kore.ai"]);
});

test("formatMultiValueInput round-trips a parsed array back to the same displayable text", () => {
  const values = ["System Integrator", "Consulting", "MSP"];
  assert.equal(formatMultiValueInput(values), "System Integrator, Consulting, MSP");
});

test("formatMultiValueInput treats null/undefined as no configured values, not a crash", () => {
  assert.equal(formatMultiValueInput(null), "");
  assert.equal(formatMultiValueInput(undefined), "");
  assert.equal(formatMultiValueInput([]), "");
});

// ---- parseLineDelimitedInput (search queries -- newline, not comma,
// delimited: queries may legitimately contain commas) ---------------------

test("check: a trailing blank line (e.g. just pressed Enter) does not produce a trailing empty entry", () => {
  assert.deepEqual(parseLineDelimitedInput('"Genesys partner" + banking\n'), ['"Genesys partner" + banking']);
});

test("check: commas inside a query line are preserved, never split on", () => {
  assert.deepEqual(parseLineDelimitedInput('"Genesys partner" + banking, Germany'), ['"Genesys partner" + banking, Germany']);
});

test("check: multiple query lines parse correctly at save", () => {
  const raw = '"Genesys partner" + banking\n"launched an AI practice" + Germany';
  assert.deepEqual(parseLineDelimitedInput(raw), ['"Genesys partner" + banking', '"launched an AI practice" + Germany']);
});

test("check: blank lines between queries never produce empty entries", () => {
  assert.deepEqual(parseLineDelimitedInput("query one\n\n\nquery two"), ["query one", "query two"]);
});

test("formatLineDelimitedInput round-trips a parsed array back to newline-joined text", () => {
  assert.equal(formatLineDelimitedInput(["a", "b"]), "a\nb");
  assert.equal(formatLineDelimitedInput(null), "");
});
