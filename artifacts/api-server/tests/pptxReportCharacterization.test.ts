// Phase 8: the REAL characterization test for the pre-Phase-8 quarterly deck
// (services/pptxReport.ts's buildQuarterlyReportPptx), run BEFORE and AFTER
// the pptxLayout.ts extraction to prove that refactor was behavior-
// preserving. Unlike tests/pptxLayoutFormatting.test.ts (which only covers
// the extracted pure formatting helpers), this test drives the actual deck
// builder end to end and inspects the generated OOXML.
//
// Deterministic and DB-free: buildHeadOfChannelsData/buildKpiDetailWithFx
// (the only two kpiService exports buildQuarterlyReportPptx calls) are
// replaced with fixture data via node:test's mock.module() -- the real
// kpiService.ts (and its @workspace/db import chain) is never loaded, so
// this needs no disposable Postgres and makes no live provider call. Must
// be run with --experimental-test-module-mocks (see package.json's
// test:pptx-quarterly-characterization script).
//
// METRIC_REGISTRY/isMoneyMetric/resolvePeriodRange are the REAL
// (unmocked) kpiRegistry.ts exports -- pure, DB-free -- so the fixture key
// lists can never silently drift from what buildQuarterlyReportPptx itself
// iterates.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { METRIC_REGISTRY } from "../src/services/kpiRegistry";
import type { FxInfo } from "../src/services/fx";

const FX_USD: FxInfo = { currency: "USD", usd_to_currency_rate: 1, as_of: null, source: null, stale: false };
const LAST_UPDATED = "2026-07-01T00:00:00.000Z";
const PERIOD_KEY = "2026-q3";
const TARGET = { territoryId: null, territoryName: "Global" };

function devKeys() {
  return METRIC_REGISTRY.filter((m) => m.views.includes("partner_development")).map((m) => m.key);
}
function commercialKeys() {
  return METRIC_REGISTRY.filter((m) => m.views.includes("weekly_commercial")).map((m) => m.key);
}
function marketingKeys() {
  return METRIC_REGISTRY.filter((m) => m.views.includes("weekly_marketing")).map((m) => m.key);
}

function fakeDevRow(key: string, dataStatus: "CONNECTED" | "DEMO") {
  const def = METRIC_REGISTRY.find((m) => m.key === key)!;
  return {
    metric_key: key,
    metric: def.label,
    current: 100,
    target: 80,
    status: "green" as const,
    what_changed: `${def.label} moved this period (fixture)`,
    explanation: `${def.label} fixture explanation`,
    data_source: "Fixture",
    last_updated: LAST_UPDATED,
    last_updated_is_synthetic: false,
    data_status: dataStatus,
  };
}
function fakeCommercialRow(key: string, dataStatus: "CONNECTED" | "DEMO") {
  const def = METRIC_REGISTRY.find((m) => m.key === key)!;
  return {
    metric_key: key,
    metric: def.label,
    current: 100,
    last_week: 90,
    target: 80,
    trend: "up" as const,
    explanation: `${def.label} fixture explanation`,
    data_source: "Fixture",
    last_updated: LAST_UPDATED,
    last_updated_is_synthetic: false,
    data_status: dataStatus,
  };
}
function fakeMarketingRow(key: string, dataStatus: "CONNECTED" | "DEMO") {
  const def = METRIC_REGISTRY.find((m) => m.key === key)!;
  return {
    metric_key: key,
    metric: def.label,
    this_week: 5,
    last_week: 3,
    trend: "up" as const,
    explanation: `${def.label} fixture explanation`,
    data_source: "Fixture",
    last_updated: LAST_UPDATED,
    last_updated_is_synthetic: false,
    data_status: dataStatus,
  };
}

function fakeDetail(key: string) {
  const def = METRIC_REGISTRY.find((m) => m.key === key)!;
  return {
    metric_key: key,
    metric: def.label,
    period: "Q3 2026",
    territory: "Global",
    current: 100,
    target: 80,
    last_week: 90,
    trend: "up" as const,
    status: "green" as const,
    data_status: "CONNECTED" as const,
    data_source: "Fixture",
    last_updated: LAST_UPDATED,
    what_changed: `${def.label} moved this period (fixture)`,
    explanation: `${def.label} fixture explanation`,
    by_territory: [
      { territory_id: "t1", territory_name: "Nordics", value: 60 },
      { territory_id: "t2", territory_name: "DACH", value: 40 },
    ],
    records: [],
    reconciles: true,
    reconciliation_note: null,
    target_to_date: 70,
    full_period_target: 80,
    full_period_target_label: "Full-quarter target" as const,
    variance: 30,
    pam_contribution: [
      { pam_user_id: "u1", pam_name: "Anna", territory_id: "t1", territory_name: "Nordics", value: 60 },
      { pam_user_id: "u2", pam_name: "James", territory_id: "t2", territory_name: "DACH", value: 40 },
    ],
    fx: FX_USD,
  };
}

interface BuildOptions {
  hasDemoData: boolean;
}

// node:test's mock.module() throws ERR_INVALID_STATE if the same URL is
// mocked twice, and re-importing an already-cached ES module does not
// re-evaluate it -- so the mock must be registered EXACTLY ONCE, with
// mutable fixture state the mocked functions read at CALL time (closure
// over `currentFixture`, reassigned by buildFixtureDeck before each
// buildQuarterlyReportPptx invocation), rather than baked in at
// registration time.
let currentFixture: {
  dev: ReturnType<typeof fakeDevRow>[];
  commercial: ReturnType<typeof fakeCommercialRow>[];
  marketing: ReturnType<typeof fakeMarketingRow>[];
  detailByKey: Map<string, ReturnType<typeof fakeDetail>>;
} | null = null;

const kpiServiceUrl = new URL("../src/services/kpiService.ts", import.meta.url).href;
// Mocks kpiService's two runtime exports pptxReport.ts actually imports
// (buildHeadOfChannelsData, buildKpiDetailWithFx -- `ResolvedTerritory` is a
// type-only import, erased at runtime) so the real kpiService.ts, and its
// @workspace/db import chain, is never loaded. kpiRegistry.ts/fx.ts stay
// real -- both are pure/DB-free.
mock.module(kpiServiceUrl, {
  exports: {
    buildHeadOfChannelsData: async () => {
      if (!currentFixture) throw new Error("currentFixture not set -- call buildFixtureDeck, not buildQuarterlyReportPptx directly");
      const { dev, commercial, marketing } = currentFixture;
      return { partnerDevelopment: dev, weeklyCommercial: commercial, weeklyMarketing: marketing, fx: FX_USD };
    },
    buildKpiDetailWithFx: async (metricKey: string) => {
      if (!currentFixture) throw new Error("currentFixture not set -- call buildFixtureDeck, not buildQuarterlyReportPptx directly");
      return currentFixture.detailByKey.get(metricKey);
    },
  },
});

// Dynamic import, AFTER mock.module -- a static top-level import would
// resolve (and cache) the real module graph before the mock is installed.
// Cached after the first call (module identity is stable), which is fine:
// buildQuarterlyReportPptx's own behavior only varies through
// `currentFixture`, never through re-importing.
let buildQuarterlyReportPptxRef: typeof import("../src/services/pptxReport").buildQuarterlyReportPptx | null = null;

async function buildFixtureDeck(options: BuildOptions): Promise<Buffer> {
  currentFixture = {
    dev: devKeys().map((key, i) => fakeDevRow(key, options.hasDemoData && i === 0 ? "DEMO" : "CONNECTED")),
    commercial: commercialKeys().map((key) => fakeCommercialRow(key, "CONNECTED")),
    marketing: marketingKeys().map((key) => fakeMarketingRow(key, "CONNECTED")),
    detailByKey: new Map(devKeys().map((key) => [key, fakeDetail(key)])),
  };

  if (!buildQuarterlyReportPptxRef) {
    ({ buildQuarterlyReportPptx: buildQuarterlyReportPptxRef } = await import("../src/services/pptxReport"));
  }
  return buildQuarterlyReportPptxRef({ periodKey: PERIOD_KEY, target: TARGET, currency: "USD" });
}

interface UnzippedDeck {
  buffer: Buffer;
  slideXmls: string[]; // ppt/slides/slideN.xml contents, in slide-number order (raw, still XML-escaped)
  allText: string; // every slide's <a:t> text runs, concatenated and XML-entity-decoded
}

// OOXML text runs are XML-escaped (e.g. the literal "&" in "Data sources &
// quality" is written as "&amp;") -- must decode before substring-matching
// against the original, human-authored strings in pptxReport.ts.
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractSlideText(xml: string): string {
  const textRunPattern = /<a:t>([^<]*)<\/a:t>/g;
  return [...xml.matchAll(textRunPattern)].map((m) => decodeXmlEntities(m[1])).join(" ");
}

async function unzipDeck(buffer: Buffer): Promise<UnzippedDeck> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)![1]);
      const nb = Number(b.match(/slide(\d+)\.xml/)![1]);
      return na - nb;
    });
  assert.ok(slideFiles.length > 0, "expected at least one ppt/slides/slideN.xml entry in the generated PPTX");

  const slideXmls = await Promise.all(slideFiles.map((name) => zip.file(name)!.async("string")));
  const allText = slideXmls.map(extractSlideText).join(" \n ");

  return { buffer, slideXmls, allText };
}

test("buildQuarterlyReportPptx: produces a valid, non-empty PPTX (OOXML zip) buffer", async () => {
  const buffer = await buildFixtureDeck({ hasDemoData: false });
  assert.ok(buffer.length > 10_000, `expected a non-trivial PPTX file, got ${buffer.length} bytes`);
  assert.equal(buffer[0], 0x50); // "PK\x03\x04" zip magic bytes
  assert.equal(buffer[1], 0x4b);
  const zip = await JSZip.loadAsync(buffer); // proves it's a well-formed zip, not just magic bytes
  assert.ok(zip.file("ppt/presentation.xml"), "expected a ppt/presentation.xml entry in a valid PPTX");
});

test("buildQuarterlyReportPptx: produces exactly 9 slides for the Global scope (cover, exec summary, 3 metric tables, PAM contribution, highlights, data quality, closing)", async () => {
  const { slideXmls } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  assert.equal(slideXmls.length, 9);
});

test("buildQuarterlyReportPptx: cover slide is first, closing slide is last -- structural sequence, not just presence", async () => {
  const { slideXmls } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  const first = slideXmls[0];
  const last = slideXmls[slideXmls.length - 1];
  assert.match(first, /Partner Report/);
  assert.match(first, /Channels and alliances/);
  assert.doesNotMatch(first, /Thank you/);
  assert.match(last, /Thank you/);
  assert.doesNotMatch(last, /Partner Report/);
});

test("buildQuarterlyReportPptx: renders every expected section heading", async () => {
  const { allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  for (const heading of [
    "Executive summary",
    "Partner development — channel performance",
    "Commercial performance",
    "Channel marketing",
    "PAM / territory contribution",
    "What changed this period",
    "Data sources & quality",
  ]) {
    assert.ok(allText.includes(heading), `expected deck text to contain heading "${heading}"`);
  }
});

test("buildQuarterlyReportPptx: partner development table has its full locked column set, including the target-to-date/full-period-target/variance/status columns", async () => {
  const { allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  for (const header of ["Metric", "Current", "Target-to-date", "Full-quarter target", "Variance", "Status", "Data status"]) {
    assert.ok(allText.includes(header), `expected partner development table to contain column header "${header}"`);
  }
  // Every partner_development metric label from the real registry must
  // actually be rendered as a row.
  for (const key of devKeys()) {
    const label = METRIC_REGISTRY.find((m) => m.key === key)!.label;
    assert.ok(allText.includes(label), `expected partner development table to render a row for "${label}"`);
  }
});

test("buildQuarterlyReportPptx: commercial performance table includes Last week and Target (the previously-missing-Target regression this shape locks in)", async () => {
  const { allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  for (const header of ["Last week", "Target", "Trend"]) {
    assert.ok(allText.includes(header), `expected commercial performance table to contain column header "${header}"`);
  }
});

test("buildQuarterlyReportPptx: channel marketing table is Current/Trend only -- never a comparison column or a week label (marketing metrics are never money)", async () => {
  const { slideXmls, allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  const marketingSlide = slideXmls.find((xml) => xml.includes("Channel marketing"))!;
  assert.ok(marketingSlide, "expected a slide containing the Channel marketing heading");
  const marketingSlideText = extractSlideText(marketingSlide);
  assert.ok(marketingSlideText.includes("Current"), "mixed-source rows get a neutral header");
  assert.ok(!marketingSlideText.includes("This week"), "never a calendar-week label");
  assert.ok(!marketingSlideText.includes("Last 7 days"), "DEMO/MANUAL rows are not rolling 7-day values");
  assert.ok(!marketingSlideText.includes("Last week"), "the Channel marketing table must never render a Last week column");
  assert.ok(allText.includes("Channel marketing")); // sanity: the heading itself is somewhere in the deck
});

test("buildQuarterlyReportPptx: PAM/territory contribution table renders territory/PAM names and the 3 money columns for the Global scope", async () => {
  const { allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  for (const cell of ["Territory", "PAM", "Partner-sourced pipeline", "Partner-influenced pipeline", "Closed revenue", "Nordics", "DACH", "Anna", "James"]) {
    assert.ok(allText.includes(cell), `expected PAM/territory contribution table to contain "${cell}"`);
  }
});

test("buildQuarterlyReportPptx: DEMO data present -> renders the DEMO-data disclosure sentence, not the all-connected sentence", async () => {
  const { allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: true }));
  assert.ok(allText.includes("Some metrics in this report use seeded demo data"));
  assert.ok(!allText.includes("All metrics in this report are sourced from connected, live, or manually entered data."));
});

test("buildQuarterlyReportPptx: no DEMO data -> renders the all-connected sentence, not the DEMO-data disclosure", async () => {
  const { allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  assert.ok(allText.includes("All metrics in this report are sourced from connected, live, or manually entered data."));
  assert.ok(!allText.includes("Some metrics in this report use seeded demo data"));
});

test("buildQuarterlyReportPptx: data quality slide states figures are produced by the same KPI service Overview uses, and includes a data-freshness callout from real fixture timestamps", async () => {
  const { allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  assert.ok(allText.includes("Every figure in this deck is produced by the same KPI service that powers the Overview dashboard"));
  assert.ok(allText.includes("2026-07-01"), "expected the fixture's last_updated date to appear in the data-freshness callout");
});

test("buildQuarterlyReportPptx: renders What changed content from real what_changed explanations, never a fabricated placeholder when data exists", async () => {
  const { allText } = await unzipDeck(await buildFixtureDeck({ hasDemoData: false }));
  assert.ok(allText.includes("(fixture)"), "expected at least one real what_changed line to appear on the highlights slide");
  assert.ok(!allText.includes("No notable changes recorded for this period."));
});
