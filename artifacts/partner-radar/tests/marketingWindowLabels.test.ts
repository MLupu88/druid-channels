// Reporting truthfulness (5B.1): the Overview's live (CONNECTED/ACTIVITIES)
// marketing KPIs are rolling windows (last 7 days vs previous 7 days, see the
// API server's kpiService.weekWindow), not calendar weeks. DEMO/MANUAL rows
// carry quarterly values, so the shared table column is neutral ("Current")
// and only the CONNECTED drawer comparison says "Previous 7 days".
// Same source-text-boundary convention as tests/reportingNavigation.test.ts:
// this project has no component rendering harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const overviewSource = readFileSync(path.join(__dirname, "../src/pages/overview.tsx"), "utf-8");

function marketingTableSource(): string {
  const start = overviewSource.indexOf("Weekly channel marketing</h3>");
  assert.ok(start > 0, "expected the Weekly channel marketing table");
  return overviewSource.slice(start, overviewSource.indexOf("</Table>", start));
}

test("Overview marketing table: the mixed-source value column has a neutral header -- not This Week, not Last 7 days", () => {
  const table = marketingTableSource();
  assert.ok(table.includes(">Current</TableHead>"));
  assert.ok(!/This Week|Last 7 days/i.test(table));
  assert.ok(table.includes("row.this_week"), "the historical API field name is unchanged");
});

test("Overview KPI drawer: a live marketing activity comparison is labeled Previous 7 days; other metrics keep Last week", () => {
  assert.ok(overviewSource.includes("kpis?.weekly_marketing.some((r) => r.metric_key === detail.metric_key)"));
  assert.ok(overviewSource.includes("? 'Previous 7 days'"));
  assert.ok(overviewSource.includes(": 'Last week'}"));
});
