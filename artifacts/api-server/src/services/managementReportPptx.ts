import pptxgenjsImport from "pptxgenjs";

const PptxGenJS = (pptxgenjsImport as unknown as { default?: typeof pptxgenjsImport }).default ?? pptxgenjsImport;
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
  formatValue,
  formatStatus,
  createSlideBuilder,
} from "../lib/pptxLayout";
import { getManagementReportSummary, type ManagementReportOptions } from "./managementReportingService";
import type { ManagementComparisons } from "./managementReportContract";
import type { ActingUser } from "./authz";
import { isMoneyMetric } from "./kpiRegistry";
import type { TargetStatus } from "./targetService";

// Subtitle under the "Won revenue (USD)" week tile. Only a real
// completed-week comparison gets a signed delta and a green/red direction;
// an unavailable one (week in progress) renders a neutral, grey message --
// never a delta computed from a partial week.
export function weekOverWeekRevenueSubtitle(
  weekOverWeek: Pick<ManagementComparisons["week_over_week"], "comparison_available" | "delta">,
): { text: string; color: string } {
  if (!weekOverWeek.comparison_available || weekOverWeek.delta === null) {
    return { text: "Comparison unavailable — week in progress", color: BRAND_GREY };
  }
  const weekDelta = weekOverWeek.delta.won_revenue_usd.total;
  return {
    text: `${weekDelta >= 0 ? "+" : "-"}${formatMoney(Math.abs(weekDelta), "USD")} vs. previous week`,
    color: weekDelta >= 0 ? GOOD_COLOR : BAD_COLOR,
  };
}

// Phase 8 -- the Head/Admin management deck. Built from the EXACT SAME
// getManagementReportSummary() payload the Overview management view
// renders (Phase 8 correction #5) -- this module only formats and lays out
// values it is handed, it never recomputes a figure. Uses the shared
// pptxLayout module (branding/formatting/slide-builder) the original
// quarterly deck (pptxReport.ts) also uses, so both decks look like one
// system.
// Target-attainment Status cell. no_target/unavailable are neutral, never
// performance exceptions -- not bold, and never given a behind/ahead colour.
// Exported for DB-free unit tests only.
export function targetStatusCell(status: TargetStatus): { text: string; color: string | undefined; bold: boolean } {
  const neutral = status === "no_target" || status === "unavailable";
  return { text: formatStatus(status), color: neutral ? undefined : (STATUS_COLOR[status] ?? undefined), bold: !neutral };
}

export async function buildManagementReportPptx(actingUser: ActingUser, options: ManagementReportOptions): Promise<Buffer> {
  const summary = await getManagementReportSummary(actingUser, options);
  const { report_context, weekly, quarter_to_date, comparisons, management_insights, data_quality } = summary;
  const currency = report_context.currency;

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "WIDE";

  const contextSubtitle = `Week of ${report_context.week_start} · ${report_context.quarter_to_date_period_label} · ${report_context.territory_name} · ${currency}`;
  const { addSectionHeader, addTableSlide, addRawSlide, stampFooters } = createSlideBuilder(pptx, contextSubtitle);

  // 1. Cover
  const cover = addRawSlide();
  cover.background = { color: BRAND_NAVY };
  const logoW = 2.4;
  cover.addImage({ data: DRUID_LOGO_DATA_URI, x: 0.6, y: 0.6, w: logoW, h: logoW * LOGO_ASPECT_RATIO });
  cover.addText("Channels and alliances", { x: 0.6, y: 2.5, w: 12, h: 0.6, fontSize: 20, color: "C9D6EA" });
  cover.addText("Management Report", { x: 0.6, y: 3.1, w: 12, h: 0.9, fontSize: 34, bold: true, color: "FFFFFF" });
  cover.addText(
    `Week of ${report_context.week_start}    ·    ${report_context.quarter_to_date_period_label}    ·    ${report_context.territory_name}`,
    { x: 0.6, y: 4.0, w: 12, h: 0.5, fontSize: 16, color: "C9D6EA" },
  );
  cover.addText(`Generated ${report_context.generated_at.slice(0, 10)}`, { x: 0.6, y: 6.8, w: 12, h: 0.4, fontSize: 11, color: "8FA3C4" });

  // 2. Executive summary -- explicitly split into a WEEK block and a
  // QUARTER-TO-DATE block, never merged into one undifferentiated set of
  // tiles, so the two time windows are never mistaken for each other.
  const summarySlide = addSectionHeader("Executive summary");
  summarySlide.addText("This week", { x: 0.6, y: 1.55, w: 6, h: 0.35, fontSize: 14, bold: true, color: BRAND_NAVY });
  summarySlide.addText(`${report_context.quarter_to_date_period_label} (to date)`, { x: 6.85, y: 1.55, w: 6, h: 0.35, fontSize: 14, bold: true, color: BRAND_NAVY });

  const weekWon = comparisons.week_over_week.current_week.won_revenue_usd.total;
  const weekRevenueSub = weekOverWeekRevenueSubtitle(comparisons.week_over_week);
  const qtdClosedRevenueRow = quarter_to_date.commercial.partnerDevelopment.find((r) => r.metric_key === "closed_revenue");

  const tile = (x: number, y: number, label: string, value: string, sub: string, subColor?: string) => {
    const w = 5.65;
    const h = 1.75;
    summarySlide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: "F7F9FC" }, line: { color: "E5E7EB", width: 1 } });
    summarySlide.addText(label, { x: x + 0.3, y: y + 0.18, w: w - 0.6, h: 0.35, fontSize: 12, bold: true, color: BRAND_GREY });
    summarySlide.addText(value, { x: x + 0.3, y: y + 0.55, w: w - 0.6, h: 0.7, fontSize: 28, bold: true, color: BRAND_NAVY });
    summarySlide.addText(sub, { x: x + 0.3, y: y + h - 0.42, w: w - 0.6, h: 0.32, fontSize: 11, color: subColor ?? BRAND_GREY });
  };

  tile(0.6, 2.0, "Won revenue (USD)", formatMoney(weekWon, "USD"), weekRevenueSub.text, weekRevenueSub.color);
  tile(0.6, 3.9, "Opportunities created", formatCount(comparisons.week_over_week.current_week.opportunities_created_count), "This week", BRAND_GREY);
  tile(
    6.85,
    2.0,
    "Closed revenue",
    formatValue(qtdClosedRevenueRow?.current ?? null, true, currency),
    `Target: ${formatValue(qtdClosedRevenueRow?.target ?? null, true, currency)}`,
    BRAND_GREY,
  );
  tile(
    6.85,
    3.9,
    "Open pipeline (current, USD)",
    formatMoney(comparisons.week_over_week.open_pipeline.current_open_pipeline_usd.total, "USD"),
    "Current state -- not a week-over-week figure",
    BRAND_GREY,
  );

  // 3. Quarter-to-date commercial performance -- reuses the exact same
  // partner_development rows Overview/the quarterly PPTX render.
  addTableSlide(
    `Commercial performance — ${report_context.quarter_to_date_period_label}`,
    [
      { header: "Metric", cell: (r: (typeof quarter_to_date.commercial.partnerDevelopment)[number]) => ({ text: r.metric }) },
      { header: "Current", cell: (r) => ({ text: formatValue(r.current, isMoneyMetric(r.metric_key), currency) }) },
      { header: "Target", cell: (r) => ({ text: formatValue(r.target, isMoneyMetric(r.metric_key), currency) }) },
      { header: "Status", cell: (r) => ({ text: formatStatus(r.status), color: r.status ? STATUS_COLOR[r.status] : undefined, bold: Boolean(r.status) }) },
      { header: "Data status", cell: (r) => ({ text: dataStatusLabel(r.data_status), color: dataStatusColor(r.data_status) }) },
    ],
    quarter_to_date.commercial.partnerDevelopment,
  );

  // 4. Target attainment / PAM comparison -- one row per (PAM, territory),
  // sourced from targetService.getTeamTargets verbatim.
  addTableSlide(
    "Target attainment — PAM comparison",
    [
      { header: "PAM", cell: (r: (typeof quarter_to_date.targets)[number]) => ({ text: r.pam_name }) },
      { header: "Territory", cell: (r) => ({ text: r.territory_name }) },
      { header: "Metric", cell: (r) => ({ text: r.metric_label }) },
      { header: "Actual", cell: (r) => ({ text: formatValue(r.actual_value, isMoneyMetric(r.metric_key), currency) }) },
      { header: "Target", cell: (r) => ({ text: formatValue(r.target_value, isMoneyMetric(r.metric_key), currency) }) },
      {
        header: "Status",
        cell: (r) => targetStatusCell(r.status),
      },
    ],
    quarter_to_date.targets,
  );

  // 5. Partner recruitment -- current_state and period_transitions rendered
  // as two visually separate blocks so a live snapshot is never mistaken
  // for something that happened during the quarter.
  const recruitmentSlide = addSectionHeader("Partner recruitment");
  recruitmentSlide.addText(`Current pipeline (as of ${quarter_to_date.recruitment.current_state.as_of.slice(0, 10)})`, {
    x: 0.6, y: 1.55, w: 12, h: 0.35, fontSize: 14, bold: true, color: BRAND_NAVY,
  });
  const stageEntries = Object.entries(quarter_to_date.recruitment.current_state.by_stage);
  recruitmentSlide.addText(
    stageEntries.map(([stage, count]) => `${formatStatus(stage)}: ${formatCount(count)}`).join("    ·    "),
    { x: 0.6, y: 1.95, w: 12, h: 0.5, fontSize: 13, color: "1F2937" },
  );
  recruitmentSlide.addText(`Movement during ${report_context.quarter_to_date_period_label} (to date)`, {
    x: 0.6, y: 2.7, w: 12, h: 0.35, fontSize: 14, bold: true, color: BRAND_NAVY,
  });
  const pt = quarter_to_date.recruitment.period_transitions;
  recruitmentSlide.addText(
    [
      { text: `New recruitments: ${formatCount(pt.new_recruitments_count)}`, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } },
      { text: `Stage transitions: ${formatCount(pt.stage_transitions_count)}`, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } },
      { text: `Signed: ${formatCount(pt.signed_count)}`, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } },
    ],
    { x: 0.6, y: 3.1, w: 12, h: 2 },
  );

  // 6. Partner-linked marketing contribution.
  const marketingSlide = addSectionHeader(`Partner-linked marketing — ${report_context.quarter_to_date_period_label}`);
  marketingSlide.addText(
    [
      { text: `Activities logged: ${formatCount(quarter_to_date.marketing.activity_count)}`, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } },
      {
        text: `Unique linked opportunities: ${formatCount(quarter_to_date.marketing.unique_linked_opportunity_count)}`,
        options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 },
      },
      { text: `Linked open pipeline: ${formatMoney(quarter_to_date.marketing.open_pipeline_usd, "USD")}`, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } },
      { text: `Linked won revenue: ${formatMoney(quarter_to_date.marketing.won_revenue_usd, "USD")}`, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } },
    ],
    { x: 0.6, y: 1.8, w: 12, h: 3 },
  );

  // 7. Weekly PAM insights -- submitted/outstanding, wins/risks/priorities/
  // help, sourced verbatim from weekly.team_weekly_report (Phase 7).
  const weeklySlide = addSectionHeader(`Weekly PAM reporting — week of ${report_context.week_start}`);
  const rs = weekly.team_weekly_report.report_state_summary;
  weeklySlide.addText(
    `Submitted: ${rs.submitted_count}    ·    Draft: ${rs.draft_count}    ·    Outstanding: ${data_quality.weekly_report_completeness.outstanding_count}`,
    { x: 0.6, y: 1.55, w: 12, h: 0.4, fontSize: 14, bold: true, color: BRAND_NAVY },
  );
  const helpLines =
    weekly.team_weekly_report.help_requests.length > 0
      ? weekly.team_weekly_report.help_requests.map((h) => `${h.pam_name}: ${h.help_needed}`)
      : ["No help requests recorded this week."];
  weeklySlide.addText(
    helpLines.map((t) => ({ text: t, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 14 } })),
    { x: 0.6, y: 2.1, w: 12, h: 2.4 },
  );
  if (data_quality.weekly_report_completeness.outstanding_pam_names.length > 0) {
    weeklySlide.addText(`Outstanding: ${data_quality.weekly_report_completeness.outstanding_pam_names.join(", ")}`, {
      x: 0.6, y: 4.7, w: 12, h: 0.4, fontSize: 13, color: BAD_COLOR,
    });
  }

  // 8. Management insights -- deterministic, rule-based, metric-backed only.
  const insightsSlide = addSectionHeader("Management insights");
  const insightLines =
    management_insights.length > 0
      ? management_insights.map((i) => i.text)
      : ["No notable insights for this selection."];
  insightsSlide.addText(
    insightLines.slice(0, 10).map((t) => ({ text: t, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } })),
    { x: 0.6, y: 1.8, w: 12, h: 4.8 },
  );

  // 9. Data quality / FX metadata.
  const dataSlide = addSectionHeader("Data sources & quality");
  const sourceLines = [
    data_quality.has_demo_data
      ? "Some metrics in this report use seeded demo data (labeled Demo data above), not a live CRM sync."
      : "All metrics in this report are sourced from connected, live, or manually entered data.",
    "Every figure in this deck is produced by the exact same management-report payload the Overview management view renders — nothing here is calculated separately for the export.",
    ...data_quality.historical_data_caveats,
    data_quality.fx_description_line,
  ];
  dataSlide.addText(
    sourceLines.map((t) => ({ text: t, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } })),
    { x: 0.6, y: 1.8, w: 12, h: 4.5 },
  );

  // 10. Closing
  const closing = addRawSlide();
  closing.background = { color: BRAND_NAVY };
  closing.addText("Thank you", { x: 0.6, y: 3.0, w: 12, h: 0.8, fontSize: 30, bold: true, color: "FFFFFF" });
  closing.addText("DRUID — Channels and alliances", { x: 0.6, y: 3.8, w: 12, h: 0.5, fontSize: 14, color: "C9D6EA" });

  stampFooters();

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}
