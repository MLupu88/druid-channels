import { db } from "@workspace/db";
import { territoriesTable, partnerOpportunitiesTable, kpiSnapshotsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PIPELINE_ATTRIBUTION_BY_KEY, mondayOf } from "./kpiService";
import { resolveFx, type SupportedCurrency } from "./fx";
import { METRIC_BY_KEY } from "./kpiRegistry";

// Sunday (UTC, YYYY-MM-DD) of the calendar week starting at `mondayStr`.
function sundayOf(mondayStr: string): string {
  const d = new Date(mondayStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

interface SnapshotWrite {
  metricName: string;
  territoryId: string | null;
  periodStart: string;
  periodEnd: string;
  currentValue: number;
  targetValue: number | null;
}

// Upserts one weekly kpi_snapshots row, targeting whichever partial unique
// index matches this row (kpi_snapshots_territory_period_unique for a real
// territory, kpi_snapshots_global_period_unique for the Global row) --
// mirroring the schema's own split exactly. Repeated daily calls for the
// same metric/territory/week update the existing row in place instead of
// creating duplicates. last_week_value is deliberately never written here;
// readers derive Last Week from the previous week's own persisted row
// (see kpiService.ts's previousWeekSnapshotValue).
async function upsertSnapshot(write: SnapshotWrite): Promise<void> {
  const values = {
    metricName: write.metricName,
    territoryId: write.territoryId,
    periodStart: write.periodStart,
    periodEnd: write.periodEnd,
    currentValue: String(write.currentValue),
    targetValue: write.targetValue !== null ? String(write.targetValue) : null,
  };

  if (write.territoryId === null) {
    await db
      .insert(kpiSnapshotsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [kpiSnapshotsTable.metricName, kpiSnapshotsTable.periodStart],
        targetWhere: sql`${kpiSnapshotsTable.territoryId} IS NULL`,
        set: {
          currentValue: values.currentValue,
          targetValue: values.targetValue,
          periodEnd: values.periodEnd,
          updatedAt: new Date(),
        },
      });
  } else {
    await db
      .insert(kpiSnapshotsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [kpiSnapshotsTable.metricName, kpiSnapshotsTable.territoryId, kpiSnapshotsTable.periodStart],
        targetWhere: sql`${kpiSnapshotsTable.territoryId} IS NOT NULL`,
        set: {
          currentValue: values.currentValue,
          targetValue: values.targetValue,
          periodEnd: values.periodEnd,
          updatedAt: new Date(),
        },
      });
  }
}

// Captures this week's current-state total for the 2 pipeline metrics that
// have no historical audit trail of their own (partner_sourced_pipeline,
// partner_influenced_pipeline) -- one row per real territory plus one
// Global row (territory_id null). Phase 5A: closed_revenue is deliberately
// NOT captured here any more -- it became a period-flow metric computed
// directly from partner_opportunities.closed_at (see kpiService.ts's
// computeClosedRevenue), which can recompute any past period on demand and
// so needs no weekly snapshot. Values are canonical USD, converted here via
// services/fx.ts (an all-USD row set never touches a live provider); the
// attribution mapping is imported from kpiService.ts, not reimplemented, so
// this can never drift from what the KPI overview/detail endpoints compute
// live.
export async function runWeeklySnapshotWriter(): Promise<void> {
  const periodStart = mondayOf(new Date());
  const periodEnd = sundayOf(periodStart);

  const territories = await db.select().from(territoriesTable);
  const allOpportunities = await db.select().from(partnerOpportunitiesTable);
  const open = allOpportunities.filter((o) => o.status === "open");

  const distinctCurrencies = [...new Set(open.map((o) => o.currency))];
  const rateByCurrency = new Map<string, number>();
  for (const currency of distinctCurrencies) {
    const fx = await resolveFx(currency as SupportedCurrency);
    rateByCurrency.set(currency, fx.usd_to_currency_rate);
  }
  const valueOf = (o: (typeof open)[number]) => Number(o.dealValue) / (rateByCurrency.get(o.currency) ?? 1);

  for (const metricKey of Object.keys(PIPELINE_ATTRIBUTION_BY_KEY)) {
    const attributionType = PIPELINE_ATTRIBUTION_BY_KEY[metricKey];
    const label = METRIC_BY_KEY.get(metricKey)!.label;
    const eligible = open.filter((o) => o.attributionType === attributionType);

    // No locked-semantics target exists for these metrics -- store null,
    // never a fabricated placeholder (the column is nullable for exactly
    // this reason).
    const targetValue: number | null = null;

    await upsertSnapshot({
      metricName: label,
      territoryId: null,
      periodStart,
      periodEnd,
      currentValue: eligible.reduce((sum, o) => sum + valueOf(o), 0),
      targetValue,
    });

    for (const t of territories) {
      const scoped = eligible.filter((o) => o.territoryId === t.id);
      await upsertSnapshot({
        metricName: label,
        territoryId: t.id,
        periodStart,
        periodEnd,
        currentValue: scoped.reduce((sum, o) => sum + valueOf(o), 0),
        targetValue,
      });
    }
  }
}
