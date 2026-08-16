// Phase 11.6F: structural/pure tests proving the evidence/DRUID-context/
// AI-interpretation/needs-validation visual hierarchy is actually wired up
// in prospects.tsx, my-prospects.tsx, and channel-radar.tsx. Same source-
// text-boundary convention as tests/connectionProviderMeta.test.ts /
// tests/druidContextFactUx.test.ts -- this project has no React rendering
// harness. Deliberately does not assert on generated sentence content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf-8");

const prospectsSource = read("../src/pages/prospects.tsx");
const myProspectsSource = read("../src/pages/my-prospects.tsx");
const channelRadarSource = read("../src/pages/channel-radar.tsx");
const blockSource = read("../src/components/interpretation-block.tsx");

// ---- shared component itself -----------------------------------------------

test("InterpretationBlock supports a distinct 'druid' tone, separate from plain interpretation", () => {
  assert.ok(blockSource.includes("'interpretation' | 'druid'"));
  assert.ok(blockSource.includes("secondary-accent"), "the druid tone must use the muted purple-gray secondary-accent token, not the brand/primary green");
});

test("InterpretationBlock never fabricates or rewrites the text it's given -- it only wraps children", () => {
  assert.ok(blockSource.includes("{children}"));
  // Checks for an actual call/generation site, not bare substring presence
  // -- this file's own explanatory comment legitimately names DeepSeek as
  // the source of the structured output it's rendering.
  for (const forbidden of ["generateText(", "summarize(", "fetch("]) {
    assert.ok(!blockSource.includes(forbidden), `InterpretationBlock must never itself generate/fetch content ("${forbidden}" found)`);
  }
});

// ---- Discovery (prospects.tsx / my-prospects.tsx) --------------------------

for (const [name, source] of [["prospects.tsx", prospectsSource], ["my-prospects.tsx", myProspectsSource]] as const) {
  test(`${name}: "Why it fits"/"Why now" are rendered via InterpretationBlock, not a bare paragraph`, () => {
    assert.ok(source.includes('<InterpretationBlock label="Why it fits">{detail.why_it_fits}</InterpretationBlock>'));
    assert.ok(source.includes('<InterpretationBlock label="Why now">{detail.why_now}</InterpretationBlock>'));
  });

  test(`${name}: evidence quote styling no longer misuses the brand/primary color`, () => {
    assert.ok(!source.includes("border-primary/40"), "a raw evidence excerpt must not be styled with the DRUID brand accent");
    assert.ok(source.includes("border-muted-foreground/30"), "expected the evidence blockquote to use a neutral/slate border instead");
  });

  test(`${name}: source URL/domain provenance is still present in the Evidence tab (not detached)`, () => {
    assert.ok(source.includes("signal.source_url"));
    assert.ok(source.includes("signal.source_domain"));
  });

  test(`${name}: no internal engine terminology (C1/C2/C3, provider_type, phase language) leaks into rendered evidence/interpretation UI`, () => {
    // Scoped to the Summary/Evidence tab region only, not the whole file
    // (which legitimately has Phase-numbered comments elsewhere).
    const summaryIdx = source.indexOf('value="summary"');
    const outreachIdx = source.indexOf('value="outreach"');
    assert.notEqual(summaryIdx, -1);
    assert.notEqual(outreachIdx, -1);
    const tabRegion = source.slice(summaryIdx, outreachIdx);
    for (const forbidden of ["provider_type", "C1", "C2", "C3", "DeepSeek", "Tavily"]) {
      assert.ok(!tabRegion.includes(forbidden), `Summary/Evidence tab region of ${name} must not expose "${forbidden}"`);
    }
  });
}

// ---- Channel Radar ----------------------------------------------------------

test("channel-radar.tsx: 'why it matters' and 'recommended action' are rendered via InterpretationBlock", () => {
  assert.ok(channelRadarSource.includes('<InterpretationBlock label="Why it matters">{detail.why_it_matters}</InterpretationBlock>'));
  assert.ok(channelRadarSource.includes('<InterpretationBlock label="Recommended action">{detail.recommended_action}</InterpretationBlock>'));
});

test("channel-radar.tsx: DRUID motion renders as its own distinct block, no longer an inline suffix inside Recommended action", () => {
  assert.ok(
    channelRadarSource.includes('<InterpretationBlock label="DRUID motion" tone="druid">{detail.druid_partner_motion}</InterpretationBlock>'),
    "expected druid_partner_motion to render via its own tone=\"druid\" InterpretationBlock",
  );
  assert.ok(!channelRadarSource.includes("DRUID motion: {detail.druid_partner_motion}"), "the old inline-suffix rendering must be gone");
});

test("channel-radar.tsx: DRUID motion is never labeled as 'DRUID context' or 'Verified DRUID context' -- no individual trusted fact is displayed here", () => {
  // Checks the actual rendered label prop, not bare substring presence --
  // this file's own explanatory comment legitimately discusses why those
  // labels were NOT chosen.
  assert.ok(!channelRadarSource.includes('label="DRUID context"'));
  assert.ok(!channelRadarSource.includes('label="Verified DRUID context"'));
  assert.ok(channelRadarSource.includes('label="DRUID motion"'), "expected the actual label to be exactly 'DRUID motion'");
});

test("channel-radar.tsx: the Evidence list keeps its clickable source_url and source_domain/title, unchanged", () => {
  assert.ok(channelRadarSource.includes("href={e.source_url}"));
  assert.ok(channelRadarSource.includes("e.source_title"));
  assert.ok(channelRadarSource.includes("e.source_domain"));
});

test("channel-radar.tsx: 'Needs validation' only ever renders from the existing requires_validation field -- no new uncertainty classifier introduced", () => {
  assert.ok(channelRadarSource.includes("detail.requires_validation && <ValidationBadge"));
  // No other ad hoc "uncertain"/"unconfirmed" condition was added elsewhere.
  const validationBadgeUses = channelRadarSource.match(/<ValidationBadge/g) ?? [];
  assert.ok(validationBadgeUses.length <= 2, "ValidationBadge should only be used in the row + detail drawer, not scattered ad hoc");
});

test("channel-radar.tsx: ValidationBadge now uses the shared --attention token, not a hand-copied orange literal", () => {
  const badgeStart = channelRadarSource.indexOf("function ValidationBadge()");
  const badgeEnd = channelRadarSource.indexOf("\n}", badgeStart);
  const badgeSource = channelRadarSource.slice(badgeStart, badgeEnd);
  assert.ok(!badgeSource.includes("orange"), "the old hand-copied orange literal must be gone");
  assert.ok(badgeSource.includes("attention"), "expected the shared --attention token instead");
});

test("channel-radar.tsx: no internal engine terminology leaks into the detail drawer region", () => {
  const drawerStart = channelRadarSource.indexOf("{/* Detail drawer */}");
  const drawerEnd = channelRadarSource.indexOf("</ScrollArea>", drawerStart);
  assert.notEqual(drawerStart, -1);
  const drawerRegion = channelRadarSource.slice(drawerStart, drawerEnd === -1 ? undefined : drawerEnd);
  for (const forbidden of ["provider_type", "C1", "C2", "C3", "DeepSeek", "Tavily"]) {
    assert.ok(!drawerRegion.includes(forbidden), `Channel Radar detail drawer must not expose "${forbidden}"`);
  }
});
