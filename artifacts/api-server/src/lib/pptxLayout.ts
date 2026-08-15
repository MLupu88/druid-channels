// Phase 8: shared PPTX branding/formatting/layout primitives, extracted from
// services/pptxReport.ts (the original quarterly deck) so
// services/managementReportPptx.ts (the new Phase 8 deck) can reuse the same
// DRUID-branded look without a second implementation. A characterization
// test (tests/pptxLayoutFormatting.test.ts) locks the pure functions' output
// before/after this extraction -- this module must stay behavior-identical
// to what pptxReport.ts had inline.
import type PptxGenJS from "pptxgenjs";
import { DRUID_LOGO_DATA_URI } from "./druidLogo";
import type { SupportedCurrency, FxInfo } from "../services/fx";

export const BRAND_NAVY = "0F2A4A";
export const BRAND_GREY = "6B7280";
export const GOOD_COLOR = "1E9E5A";
export const BAD_COLOR = "D14343";
export const STATUS_COLOR: Record<string, string> = { green: "1E9E5A", amber: "D19A0A", red: "D14343", on_track: "1E9E5A" };
export const LOGO_ASPECT_RATIO = 245 / 941; // source PNG is 941x245
export const FOOTER_LABEL = "DRUID · Channels and alliances";
export { DRUID_LOGO_DATA_URI };

export function dataStatusLabel(status: string): string {
  switch (status) {
    case "CONNECTED": return "Connected";
    case "MANUAL": return "Manual";
    case "DEMO": return "Demo data";
    default: return "Not connected";
  }
}

export function dataStatusColor(status: string): string {
  if (status === "DEMO") return "D19A0A";
  if (status === "NOT_CONNECTED") return BRAND_GREY;
  return GOOD_COLOR;
}

// Deterministic English-locale formatting regardless of server environment
// locale config -- fixed "en-US", never Intl.NumberFormat(undefined, ...).
export function formatCount(value: number | null): string {
  if (value === null) return "--";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatMoney(value: number | null, currency: SupportedCurrency): string {
  if (value === null) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

// Counts remain plain numbers; only money metrics ever get currency
// formatting -- callers pass isMoneyMetric(metricKey) explicitly so this
// never drifts from what kpiService itself treats as a money value.
export function formatValue(value: number | null, isMoney: boolean, currency: SupportedCurrency): string {
  return isMoney ? formatMoney(value, currency) : formatCount(value);
}

export function formatTrend(trend: string | null): string {
  if (!trend) return "--";
  return trend.charAt(0).toUpperCase() + trend.slice(1);
}

export function formatStatus(status: string | null): string {
  if (!status) return "--";
  return status.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Deterministic UTC timestamp for a "data freshness" callout -- never
// depends on server timezone/locale config.
export function formatFreshness(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

// Describes the Frankfurter *reference* rate only. Deliberately never uses
// the word "live" anywhere in this string, per the locked wording
// requirement -- this is a daily reference rate for reporting, not a market
// execution rate.
export function fxDescriptionLine(fx: FxInfo): string {
  if (fx.currency === "USD") {
    return "All figures are shown in USD, the currency this app stores commercial values in natively -- no conversion was applied.";
  }
  const asOf = fx.as_of ?? "an unknown date";
  const staleNote = fx.stale
    ? " The most recent successful Frankfurter lookup could not be refreshed at export time, so this is the last rate retrieved and stored (marked stale)."
    : "";
  return `Figures are converted from USD using the Frankfurter (frankfurter.app) daily reference exchange rate for ${fx.currency} as of ${asOf} (1 USD = ${fx.usd_to_currency_rate.toFixed(4)} ${fx.currency}). This is a daily reference rate for reporting purposes only, not a market execution rate.${staleNote}`;
}

export interface TableCell {
  text: string;
  color?: string;
  bold?: boolean;
}

export interface TableColumn<T> {
  header: string;
  cell: (row: T) => TableCell;
}

// Bundles the "one deck, consistent header band + footer/page-numbering"
// pattern pptxReport.ts originally implemented as inline closures over
// `pptx`/`allSlides`/`contextSubtitle`. Both buildQuarterlyReportPptx and
// buildManagementReportPptx construct one of these per deck rather than
// reimplementing slide layout.
export function createSlideBuilder(pptx: PptxGenJS, contextSubtitle: string) {
  const allSlides: ReturnType<typeof pptx.addSlide>[] = [];

  function addSectionHeader(title: string, subtitle: string = contextSubtitle) {
    const slide = pptx.addSlide();
    allSlides.push(slide);
    slide.background = { color: "FFFFFF" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 1.4, fill: { color: BRAND_NAVY } });
    slide.addText(title, { x: 0.6, y: 0.35, w: 12, h: 0.7, fontSize: 26, bold: true, color: "FFFFFF" });
    slide.addText(subtitle, { x: 0.6, y: 0.95, w: 12, h: 0.4, fontSize: 13, color: "C9D6EA" });
    return slide;
  }

  function addTableSlide<T>(title: string, columns: TableColumn<T>[], rows: T[]) {
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
  }

  function addRawSlide() {
    const slide = pptx.addSlide();
    allSlides.push(slide);
    return slide;
  }

  // Stamps a consistent brand label + "page / total" footer across every
  // tracked slide in one pass, once the final (possibly-conditional) slide
  // count is known -- must be called last.
  function stampFooters() {
    allSlides.forEach((slide, i) => {
      slide.addText(FOOTER_LABEL, { x: 0.6, y: 7.15, w: 6, h: 0.3, fontSize: 9, color: "9AA7BD" });
      slide.addText(`${i + 1} / ${allSlides.length}`, { x: 12.13, y: 7.15, w: 0.8, h: 0.3, fontSize: 9, color: "9AA7BD", align: "right" });
    });
  }

  return { addSectionHeader, addTableSlide, addRawSlide, stampFooters, allSlides };
}
