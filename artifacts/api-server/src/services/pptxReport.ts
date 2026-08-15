import pptxgenjsImport from "pptxgenjs";

// Guards against a known CJS/ESM default-export interop wrinkle: under some
// Node ESM loaders pptxgenjs's default export lands on `.default`, under
// esbuild's CJS-interop bundling it doesn't -- this works correctly either
// way.
const PptxGenJS = (pptxgenjsImport as unknown as { default?: typeof pptxgenjsImport }).default ?? pptxgenjsImport;
import { buildHeadOfChannelsData, buildKpiDetailWithFx, type ResolvedTerritory } from "./kpiService";
import { resolvePeriodRange, METRIC_REGISTRY, isMoneyMetric } from "./kpiRegistry";
import type { SupportedCurrency } from "./fx";
import {
  BRAND_NAVY,
  BRAND_GREY,
  GOOD_COLOR,
  BAD_COLOR,
  STATUS_COLOR,
  LOGO_ASPECT_RATIO,
  DRUID_LOGO_DATA_URI,
  dataStatusLabel,
  dataStatusColor,
  formatCount,
  formatMoney,
  formatValue as formatValueRaw,
  formatTrend,
  formatStatus,
  formatFreshness,
  fxDescriptionLine,
  createSlideBuilder,
} from "../lib/pptxLayout";

// Counts remain plain numbers; only the 3 money metrics ever get currency
// formatting -- reuses kpiRegistry's own isMoneyMetric so this never drifts
// from what kpiService itself treats as a money value.
function formatValue(value: number | null, metricKey: string, currency: SupportedCurrency): string {
  return formatValueRaw(value, isMoneyMetric(metricKey), currency);
}

export interface QuarterlyReportOptions {
  periodKey: string;
  target: ResolvedTerritory;
  currency: SupportedCurrency;
}

// Builds the DRUID-branded quarterly/YTD partner report exactly as PptxGenJS
// bytes. Every KPI/FX number in this deck comes from buildHeadOfChannelsData
// and buildKpiDetailWithFx (the same computation layer Overview uses) --
// this module only ever formats and lays out values it is handed, it never
// recomputes a KPI or an FX rate itself. FX is resolved exactly once (inside
// the single buildHeadOfChannelsData call below) and that one FxInfo is
// reused for every subsequent buildKpiDetailWithFx call, so the whole deck
// is internally FX-consistent and Frankfurter is never called more than once
// per export.
export async function buildQuarterlyReportPptx({ periodKey, target, currency }: QuarterlyReportOptions): Promise<Buffer> {
  const periodInfo = resolvePeriodRange(periodKey);

  const { partnerDevelopment, weeklyCommercial, weeklyMarketing, fx } = await buildHeadOfChannelsData(periodKey, target, currency);

  // Channel Performance / Partner Development locked metric set (New
  // Partner Prospects, Signed Partners, Active Onboarding, Certified
  // Partners, Partner-Sourced Pipeline, Partner-Influenced Pipeline, Closed
  // Revenue, Renewals) -- derived from the registry's own view tagging, not
  // hardcoded, so it can never drift from what buildHeadOfChannelsData
  // itself considers "partner_development".
  const channelPerformanceKeys = METRIC_REGISTRY.filter((m) => m.views.includes("partner_development")).map((m) => m.key);
  const detailEntries = await Promise.all(
    channelPerformanceKeys.map(async (key) => [key, await buildKpiDetailWithFx(key, periodKey, target, fx)] as const),
  );
  const detailByKey = new Map(detailEntries);
  const fullPeriodTargetLabel = detailEntries[0]?.[1]?.full_period_target_label ?? "Full-period target";

  const hasDemoData = [...partnerDevelopment, ...weeklyCommercial, ...weeklyMarketing].some((r) => r.data_status === "DEMO");

  // KPI/source freshness: the most recent last_updated across every metric
  // actually shown in this report, never fabricated -- omitted entirely if
  // nothing in the report carries a timestamp.
  const allTimestamps = [...partnerDevelopment, ...weeklyCommercial, ...weeklyMarketing]
    .map((r) => r.last_updated)
    .filter((t): t is string => t !== null)
    .sort();
  const freshestTimestamp = allTimestamps.length > 0 ? allTimestamps[allTimestamps.length - 1] : null;

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "WIDE";

  const contextSubtitle = `${periodInfo.label} · ${target.territoryName} · ${fx.currency}`;
  const { addSectionHeader, addTableSlide, addRawSlide, stampFooters } = createSlideBuilder(pptx, contextSubtitle);

  // 1. Cover / reporting context
  const cover = addRawSlide();
  cover.background = { color: BRAND_NAVY };
  const logoW = 2.4;
  cover.addImage({ data: DRUID_LOGO_DATA_URI, x: 0.6, y: 0.6, w: logoW, h: logoW * LOGO_ASPECT_RATIO });
  cover.addText("Channels and alliances", { x: 0.6, y: 2.5, w: 12, h: 0.6, fontSize: 20, color: "C9D6EA" });
  cover.addText(`Partner Report — ${periodInfo.label}`, { x: 0.6, y: 3.1, w: 12, h: 0.9, fontSize: 34, bold: true, color: "FFFFFF" });
  cover.addText(`Territory: ${target.territoryName}    ·    Currency: ${fx.currency}`, { x: 0.6, y: 4.0, w: 12, h: 0.5, fontSize: 16, color: "C9D6EA" });
  cover.addText(`Generated ${new Date().toISOString().slice(0, 10)}`, { x: 0.6, y: 6.8, w: 12, h: 0.4, fontSize: 11, color: "8FA3C4" });

  // 2. Executive KPI summary -- a handful of headline numbers as stat tiles.
  const summarySlide = addSectionHeader("Executive summary");
  const highlightKeys = ["new_partner_prospects", "signed_partners", "partner_sourced_pipeline", "closed_revenue"];
  const cardW = 5.65;
  const cardH = 2.1;
  const gap = 0.3;
  const cardPositions = [
    { x: 0.6, y: 1.7 },
    { x: 0.6 + cardW + gap, y: 1.7 },
    { x: 0.6, y: 1.7 + cardH + gap },
    { x: 0.6 + cardW + gap, y: 1.7 + cardH + gap },
  ];
  highlightKeys.forEach((key, i) => {
    const row = partnerDevelopment.find((r) => r.metric_key === key);
    const pos = cardPositions[i];
    if (!row) return;
    summarySlide.addShape(pptx.ShapeType.rect, {
      x: pos.x, y: pos.y, w: cardW, h: cardH,
      fill: { color: "F7F9FC" }, line: { color: "E5E7EB", width: 1 },
    });
    summarySlide.addText(row.metric, { x: pos.x + 0.3, y: pos.y + 0.22, w: cardW - 0.6, h: 0.4, fontSize: 13, bold: true, color: BRAND_GREY });
    summarySlide.addText(formatValue(row.current, key, fx.currency), {
      x: pos.x + 0.3, y: pos.y + 0.62, w: cardW - 0.6, h: 0.85, fontSize: 34, bold: true, color: BRAND_NAVY,
    });
    const targetText = `Target: ${formatValue(row.target, key, fx.currency)}`;
    summarySlide.addText(targetText, { x: pos.x + 0.3, y: pos.y + cardH - 0.5, w: cardW - 0.6, h: 0.35, fontSize: 12, color: BRAND_GREY });
  });

  // 3. Partner development / Channel Performance -- current, target-to-date,
  // full-period target, variance, status. target_to_date/variance render as
  // "--" for metrics with no defined target (never a fabricated 0).
  addTableSlide(
    "Partner development — channel performance",
    [
      { header: "Metric", cell: (r: (typeof partnerDevelopment)[number]) => ({ text: r.metric }) },
      { header: "Current", cell: (r) => ({ text: formatValue(r.current, r.metric_key, fx.currency) }) },
      {
        header: "Target-to-date",
        cell: (r) => ({ text: formatValue(detailByKey.get(r.metric_key)?.target_to_date ?? null, r.metric_key, fx.currency) }),
      },
      {
        header: fullPeriodTargetLabel,
        cell: (r) => ({ text: formatValue(detailByKey.get(r.metric_key)?.full_period_target ?? null, r.metric_key, fx.currency) }),
      },
      {
        header: "Variance",
        cell: (r) => {
          const variance = detailByKey.get(r.metric_key)?.variance ?? null;
          return {
            text: formatValue(variance, r.metric_key, fx.currency),
            color: variance === null ? undefined : variance >= 0 ? GOOD_COLOR : BAD_COLOR,
          };
        },
      },
      {
        header: "Status",
        cell: (r) => ({ text: formatStatus(r.status), color: r.status ? STATUS_COLOR[r.status] : undefined, bold: Boolean(r.status) }),
      },
      { header: "Data status", cell: (r) => ({ text: dataStatusLabel(r.data_status), color: dataStatusColor(r.data_status) }) },
    ],
    partnerDevelopment,
  );

  // 4. Commercial performance -- Current / Last Week / Target / Trend, per
  // the locked shape (previously this table was missing Target entirely).
  addTableSlide(
    "Commercial performance",
    [
      { header: "Metric", cell: (r: (typeof weeklyCommercial)[number]) => ({ text: r.metric }) },
      { header: "Current", cell: (r) => ({ text: formatValue(r.current, r.metric_key, fx.currency) }) },
      { header: "Last week", cell: (r) => ({ text: formatValue(r.last_week, r.metric_key, fx.currency) }) },
      { header: "Target", cell: (r) => ({ text: formatValue(r.target, r.metric_key, fx.currency) }) },
      { header: "Trend", cell: (r) => ({ text: formatTrend(r.trend) }) },
      { header: "Data status", cell: (r) => ({ text: dataStatusLabel(r.data_status), color: dataStatusColor(r.data_status) }) },
    ],
    weeklyCommercial,
  );

  // 5. Channel marketing -- This week / Trend only. Last Week must not be
  // visible here per the locked semantics (marketing metrics are never
  // money, so plain counts throughout).
  addTableSlide(
    "Channel marketing",
    [
      { header: "Metric", cell: (r: (typeof weeklyMarketing)[number]) => ({ text: r.metric }) },
      { header: "This week", cell: (r) => ({ text: formatCount(r.this_week) }) },
      { header: "Trend", cell: (r) => ({ text: formatTrend(r.trend) }) },
      { header: "Data status", cell: (r) => ({ text: dataStatusLabel(r.data_status), color: dataStatusColor(r.data_status) }) },
    ],
    weeklyMarketing,
  );

  // 6. PAM / territory contribution -- only meaningful when viewing the
  // Global rollup (a single-territory view already IS that one row).
  // Combines pam_contribution from the 3 money metrics, keyed by territory,
  // reusing kpiService's own PAM<->territory resolution untouched.
  if (target.territoryId === null) {
    const moneyKeys = ["partner_sourced_pipeline", "partner_influenced_pipeline", "closed_revenue"] as const;
    const byTerritory = new Map<string, { territory_name: string; pam_name: string | null; values: Partial<Record<(typeof moneyKeys)[number], number>> }>();
    for (const key of moneyKeys) {
      const detail = detailByKey.get(key);
      if (!detail) continue;
      for (const p of detail.pam_contribution) {
        const existing = byTerritory.get(p.territory_id) ?? { territory_name: p.territory_name, pam_name: p.pam_name, values: {} };
        existing.values[key] = p.value;
        byTerritory.set(p.territory_id, existing);
      }
    }
    const pamRows = Array.from(byTerritory.values());
    if (pamRows.length > 0) {
      addTableSlide(
        "PAM / territory contribution",
        [
          { header: "Territory", cell: (r: (typeof pamRows)[number]) => ({ text: r.territory_name }) },
          { header: "PAM", cell: (r) => ({ text: r.pam_name ?? "Unassigned" }) },
          { header: "Partner-sourced pipeline", cell: (r) => ({ text: formatMoney(r.values.partner_sourced_pipeline ?? null, fx.currency) }) },
          { header: "Partner-influenced pipeline", cell: (r) => ({ text: formatMoney(r.values.partner_influenced_pipeline ?? null, fx.currency) }) },
          { header: "Closed revenue", cell: (r) => ({ text: formatMoney(r.values.closed_revenue ?? null, fx.currency) }) },
        ],
        pamRows,
      );
    }
  }

  // 7. Highlights (what changed, from real explanations only -- never
  // fabricated).
  const highlightsSlide = addSectionHeader("What changed this period");
  const highlightRows = partnerDevelopment
    .filter((r) => r.what_changed)
    .slice(0, 6)
    .map((r) => `${r.metric}: ${r.what_changed}`);
  if (highlightRows.length === 0) highlightRows.push("No notable changes recorded for this period.");
  highlightsSlide.addText(
    highlightRows.map((t) => ({ text: t, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } })),
    { x: 0.6, y: 1.8, w: 12, h: 4.8 },
  );

  // 8. Data quality / freshness / FX metadata.
  const dataSlide = addSectionHeader("Data sources & quality");
  const sourceLines = [
    hasDemoData
      ? "Some metrics in this report use seeded demo data (labeled Demo data above), not a live CRM sync. Configure a source in Admin > Connections & data to replace them."
      : "All metrics in this report are sourced from connected, live, or manually entered data.",
    "Every figure in this deck is produced by the same KPI service that powers the Overview dashboard — nothing here is calculated separately for the export.",
    freshestTimestamp
      ? `Data freshness: the most recent underlying update reflected in this report is ${formatFreshness(freshestTimestamp)}.`
      : "Data freshness: no timestamped source data is available for the current selection.",
    fxDescriptionLine(fx),
  ];
  dataSlide.addText(
    sourceLines.map((t) => ({ text: t, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } })),
    { x: 0.6, y: 1.8, w: 12, h: 4.5 },
  );

  // 9. Closing
  const closing = addRawSlide();
  closing.background = { color: BRAND_NAVY };
  closing.addText("Thank you", { x: 0.6, y: 3.0, w: 12, h: 0.8, fontSize: 30, bold: true, color: "FFFFFF" });
  closing.addText("DRUID — Channels and alliances", { x: 0.6, y: 3.8, w: 12, h: 0.5, fontSize: 14, color: "C9D6EA" });

  // Footer / slide-number hierarchy: every slide gets a small, consistent
  // brand label + "page / total" in the bottom-right, added last now that
  // the final (possibly-conditional) slide count is known.
  stampFooters();

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}
