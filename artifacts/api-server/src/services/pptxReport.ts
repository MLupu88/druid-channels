import pptxgenjsImport from "pptxgenjs";

// Guards against a known CJS/ESM default-export interop wrinkle: under some
// Node ESM loaders pptxgenjs's default export lands on `.default`, under
// esbuild's CJS-interop bundling it doesn't -- this works correctly either
// way.
const PptxGenJS = (pptxgenjsImport as unknown as { default?: typeof pptxgenjsImport }).default ?? pptxgenjsImport;
import { buildHeadOfChannelsData, buildKpiDetailWithFx, type ResolvedTerritory } from "./kpiService";
import { resolvePeriodRange, METRIC_REGISTRY, isMoneyMetric } from "./kpiRegistry";
import type { SupportedCurrency, FxInfo } from "./fx";
import { DRUID_LOGO_DATA_URI } from "../lib/druidLogo";

const BRAND_NAVY = "0F2A4A";
const BRAND_GREY = "6B7280";
const GOOD_COLOR = "1E9E5A";
const BAD_COLOR = "D14343";
const STATUS_COLOR: Record<string, string> = { green: "1E9E5A", amber: "D19A0A", red: "D14343", on_track: "1E9E5A" };
const LOGO_ASPECT_RATIO = 245 / 941; // source PNG is 941x245
const FOOTER_LABEL = "DRUID · Channels and alliances";

function dataStatusLabel(status: string): string {
  switch (status) {
    case "CONNECTED": return "Connected";
    case "MANUAL": return "Manual";
    case "DEMO": return "Demo data";
    default: return "Not connected";
  }
}

function dataStatusColor(status: string): string {
  if (status === "DEMO") return "D19A0A";
  if (status === "NOT_CONNECTED") return BRAND_GREY;
  return GOOD_COLOR;
}

// Deterministic English-locale formatting regardless of server environment
// locale config -- fixed "en-US", never Intl.NumberFormat(undefined, ...).
function formatCount(value: number | null): string {
  if (value === null) return "--";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatMoney(value: number | null, currency: SupportedCurrency): string {
  if (value === null) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

// Counts remain plain numbers; only the 3 money metrics ever get currency
// formatting -- reuses kpiRegistry's own isMoneyMetric so this never drifts
// from what kpiService itself treats as a money value.
function formatValue(value: number | null, metricKey: string, currency: SupportedCurrency): string {
  return isMoneyMetric(metricKey) ? formatMoney(value, currency) : formatCount(value);
}

function formatTrend(trend: string | null): string {
  if (!trend) return "--";
  return trend.charAt(0).toUpperCase() + trend.slice(1);
}

function formatStatus(status: string | null): string {
  if (!status) return "--";
  return status.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Deterministic UTC timestamp for the "data freshness" callout -- never
// depends on server timezone/locale config.
function formatFreshness(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

// Describes the Frankfurter *reference* rate only. Deliberately never uses
// the word "live" anywhere in this string, per the locked wording
// requirement -- this is a daily reference rate for reporting, not a
// market execution rate.
function fxDescriptionLine(fx: FxInfo): string {
  if (fx.currency === "USD") {
    return "All figures are shown in USD, the currency this app stores commercial values in natively -- no conversion was applied.";
  }
  const asOf = fx.as_of ?? "an unknown date";
  const staleNote = fx.stale
    ? " The most recent successful Frankfurter lookup could not be refreshed at export time, so this is the last rate retrieved and stored (marked stale)."
    : "";
  return `Figures are converted from USD using the Frankfurter (frankfurter.app) daily reference exchange rate for ${fx.currency} as of ${asOf} (1 USD = ${fx.usd_to_currency_rate.toFixed(4)} ${fx.currency}). This is a daily reference rate for reporting purposes only, not a market execution rate.${staleNote}`;
}

interface TableCell {
  text: string;
  color?: string;
  bold?: boolean;
}

interface TableColumn<T> {
  header: string;
  cell: (row: T) => TableCell;
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

  // Every slide is tracked here so a consistent footer (brand label + page
  // number / total) can be stamped across the whole deck in one pass at the
  // end, once the final slide count is known -- content slides can be
  // conditional (e.g. PAM contribution), so the total isn't known upfront.
  const allSlides: ReturnType<typeof pptx.addSlide>[] = [];

  const addSectionHeader = (title: string, subtitle: string = contextSubtitle) => {
    const slide = pptx.addSlide();
    allSlides.push(slide);
    slide.background = { color: "FFFFFF" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 1.4, fill: { color: BRAND_NAVY } });
    slide.addText(title, { x: 0.6, y: 0.35, w: 12, h: 0.7, fontSize: 26, bold: true, color: "FFFFFF" });
    slide.addText(subtitle, { x: 0.6, y: 0.95, w: 12, h: 0.4, fontSize: 13, color: "C9D6EA" });
    return slide;
  };

  const addTableSlide = <T,>(title: string, columns: TableColumn<T>[], rows: T[]) => {
    const slide = addSectionHeader(title);
    const header = columns.map((col) => ({
      text: col.header,
      options: { bold: true, fill: { color: "EEF2FA" }, color: BRAND_NAVY, fontSize: 11 },
    }));
    const body = rows.map((row) =>
      columns.map((col) => {
        const cell = col.cell(row);
        return { text: cell.text, options: { color: cell.color ?? "1F2937", bold: Boolean(cell.bold), fontSize: 11 } };
      }),
    );
    slide.addTable([header, ...body], {
      x: 0.6, y: 1.6, w: 12.1, h: 5.2,
      fontSize: 11,
      border: { type: "solid", color: "E5E7EB", pt: 0.5 },
      autoPage: false,
    });
    return slide;
  };

  // 1. Cover / reporting context
  const cover = pptx.addSlide();
  allSlides.push(cover);
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
  const closing = pptx.addSlide();
  allSlides.push(closing);
  closing.background = { color: BRAND_NAVY };
  closing.addText("Thank you", { x: 0.6, y: 3.0, w: 12, h: 0.8, fontSize: 30, bold: true, color: "FFFFFF" });
  closing.addText("DRUID — Channels and alliances", { x: 0.6, y: 3.8, w: 12, h: 0.5, fontSize: 14, color: "C9D6EA" });

  // Footer / slide-number hierarchy: every slide gets a small, consistent
  // brand label + "page / total" in the bottom-right, added last now that
  // the final (possibly-conditional) slide count is known.
  allSlides.forEach((slide, i) => {
    slide.addText(FOOTER_LABEL, { x: 0.6, y: 7.15, w: 6, h: 0.3, fontSize: 9, color: "9AA7BD" });
    slide.addText(`${i + 1} / ${allSlides.length}`, { x: 12.13, y: 7.15, w: 0.8, h: 0.3, fontSize: 9, color: "9AA7BD", align: "right" });
  });

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}
