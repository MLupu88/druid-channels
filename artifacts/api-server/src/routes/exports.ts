import { Router, type IRouter } from "express";
import PptxGenJS from "pptxgenjs";
import { resolvePeriodKey, resolveTerritory, PERIODS, buildHeadOfChannelsData } from "../services/kpiService";

const router: IRouter = Router();

const BRAND_NAVY = "0F2A4A";
const BRAND_ACCENT = "2F6FED";
const BRAND_GREY = "6B7280";
const STATUS_COLOR: Record<string, string> = { green: "1E9E5A", amber: "D19A0A", red: "D14343", on_track: "1E9E5A" };

function dataStatusLabel(status: string): string {
  switch (status) {
    case "CONNECTED": return "Connected";
    case "MANUAL": return "Manual";
    case "DEMO": return "Demo data";
    default: return "Not connected";
  }
}

router.get("/exports/quarterly-pptx", async (req, res): Promise<void> => {
  const { territory, period } = req.query as { territory?: string; period?: string };
  const periodKey = resolvePeriodKey(period);
  const periodInfo = PERIODS[periodKey];
  const target = await resolveTerritory(territory);

  const { partnerDevelopment, weeklyCommercial, weeklyMarketing } = await buildHeadOfChannelsData(periodKey, target);
  const generatedAt = new Date();
  const hasDemoData = [...partnerDevelopment, ...weeklyCommercial, ...weeklyMarketing].some((r) => r.data_status === "DEMO");

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "WIDE";

  const addTitleSlide = () => {
    const slide = pptx.addSlide();
    slide.background = { color: BRAND_NAVY };
    slide.addText("DRUID Partner Radar", { x: 0.6, y: 2.6, w: 12, h: 0.8, fontSize: 34, bold: true, color: "FFFFFF" });
    slide.addText(`Quarterly Partner Report — ${periodInfo.label}`, { x: 0.6, y: 3.4, w: 12, h: 0.6, fontSize: 20, color: "C9D6EA" });
    slide.addText(`Territory: ${target.territoryName}`, { x: 0.6, y: 4.0, w: 12, h: 0.5, fontSize: 16, color: "C9D6EA" });
    slide.addText(`Generated ${generatedAt.toISOString().slice(0, 10)}`, { x: 0.6, y: 6.8, w: 12, h: 0.4, fontSize: 11, color: "8FA3C4" });
  };

  const addSectionHeader = (title: string, subtitle?: string) => {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 1.4, fill: { color: BRAND_NAVY } });
    slide.addText(title, { x: 0.6, y: 0.35, w: 12, h: 0.7, fontSize: 26, bold: true, color: "FFFFFF" });
    if (subtitle) slide.addText(subtitle, { x: 0.6, y: 0.95, w: 12, h: 0.4, fontSize: 13, color: "C9D6EA" });
    return slide;
  };

  const addKpiTableSlide = (
    title: string,
    rows: Array<{ metric: string; a: string; b: string; c: string; status?: string; data_status: string }>,
    columns: [string, string, string],
  ) => {
    const slide = addSectionHeader(title, `${periodInfo.label} · ${target.territoryName}`);
    const header = [
      { text: "Metric", options: { bold: true, fill: { color: "EEF2FA" }, color: BRAND_NAVY } },
      { text: columns[0], options: { bold: true, fill: { color: "EEF2FA" }, color: BRAND_NAVY } },
      { text: columns[1], options: { bold: true, fill: { color: "EEF2FA" }, color: BRAND_NAVY } },
      { text: columns[2], options: { bold: true, fill: { color: "EEF2FA" }, color: BRAND_NAVY } },
      { text: "Data status", options: { bold: true, fill: { color: "EEF2FA" }, color: BRAND_NAVY } },
    ];
    const body = rows.map((r) => [
      { text: r.metric, options: { color: "1F2937" } },
      { text: r.a, options: { color: "1F2937" } },
      { text: r.b, options: { color: "1F2937" } },
      { text: r.c, options: { color: r.status ? STATUS_COLOR[r.status] ?? "1F2937" : "1F2937", bold: Boolean(r.status) } },
      { text: dataStatusLabel(r.data_status), options: { color: r.data_status === "DEMO" ? "D19A0A" : r.data_status === "NOT_CONNECTED" ? BRAND_GREY : "1E9E5A", fontSize: 10 } },
    ]);
    slide.addTable([header, ...body], {
      x: 0.6, y: 1.6, w: 12.1, h: 5.2,
      fontSize: 12,
      border: { type: "solid", color: "E5E7EB", pt: 0.5 },
      autoPage: false,
    });
  };

  // 1. Title
  addTitleSlide();

  // 2. Partner development
  addKpiTableSlide(
    "Partner development",
    partnerDevelopment.map((r) => ({ metric: r.metric, a: String(r.current), b: String(r.target), c: r.status, status: r.status, data_status: r.data_status })),
    ["Current", "Target", "Status"],
  );

  // 3. Weekly commercial
  addKpiTableSlide(
    "Weekly commercial",
    weeklyCommercial.map((r) => ({ metric: r.metric, a: String(r.current), b: String(r.last_week), c: r.trend, data_status: r.data_status })),
    ["Current", "Last week", "Trend"],
  );

  // 4. Weekly marketing (no "last week" column shown here either, matching Overview's Table 3)
  addKpiTableSlide(
    "Weekly channel marketing",
    weeklyMarketing.map((r) => ({ metric: r.metric, a: String(r.this_week), b: r.trend, c: "", data_status: r.data_status })),
    ["This week", "Trend", ""],
  );

  // 5. Highlights (what changed, from real explanations only — never fabricated)
  const highlightsSlide = addSectionHeader("What changed this period", `${periodInfo.label} · ${target.territoryName}`);
  const highlightRows = partnerDevelopment
    .filter((r) => r.what_changed)
    .slice(0, 6)
    .map((r) => `${r.metric}: ${r.what_changed}`);
  if (highlightRows.length === 0) highlightRows.push("No notable changes recorded for this period.");
  highlightsSlide.addText(
    highlightRows.map((t) => ({ text: t, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } })),
    { x: 0.6, y: 1.8, w: 12, h: 4.8 },
  );

  // 6. Data quality / reconciliation notice
  const dataSlide = addSectionHeader("Data sources & quality", `${periodInfo.label} · ${target.territoryName}`);
  const sourceLines = [
    hasDemoData
      ? "Some metrics in this report use seeded demo data (labeled Demo data above), not a live CRM sync. Configure a source in Admin > Connections & data to replace them."
      : "All metrics in this report are sourced from connected, live, or manually entered data.",
    "Every figure in this deck is produced by the same KPI service that powers the Overview dashboard — nothing here is calculated separately for the export.",
  ];
  dataSlide.addText(
    sourceLines.map((t) => ({ text: t, options: { bullet: true, breakLine: true, color: "1F2937", fontSize: 15 } })),
    { x: 0.6, y: 1.8, w: 12, h: 3 },
  );

  // 7. Closing
  const closing = pptx.addSlide();
  closing.background = { color: BRAND_NAVY };
  closing.addText("Thank you", { x: 0.6, y: 3.0, w: 12, h: 0.8, fontSize: 30, bold: true, color: "FFFFFF" });
  closing.addText("DRUID Partner Radar — Quarterly Report", { x: 0.6, y: 3.8, w: 12, h: 0.5, fontSize: 14, color: "C9D6EA" });

  const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const fileName = `partner-radar-${periodKey}-${target.territoryName.toLowerCase().replace(/\s+/g, "-")}.pptx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(buffer);
});

export default router;
