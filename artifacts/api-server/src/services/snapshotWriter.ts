import { db } from "@workspace/db";
import { territoriesTable, prospectsTable, kpiSnapshotsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { CURRENT_STATE_FIELD_BY_KEY, isEligibleForCurrentState, mondayOf } from "./kpiService";
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

// Captures this week's current-state total for the 3 money metrics that
// have no historical audit trail of their own (partner_sourced_pipeline,
// partner_influenced_pipeline, closed_revenue) -- one row per real
// territory plus one Global row (territory_id null). Values are canonical
// USD; this writer never applies FX conversion, which only ever happens at
// display time in kpiService.ts. Eligibility and the metric->field mapping
// are imported from kpiService.ts, not reimplemented, so this can never
// drift from what the KPI overview/detail endpoints compute live.
export async function runWeeklySnapshotWriter(): Promise<void> {
  const periodStart = mondayOf(new Date());
  const periodEnd = sundayOf(periodStart);

  const territories = await db.select().from(territoriesTable);
  const allProspects = await db.select().from(prospectsTable);
  const eligible = allProspects.filter(isEligibleForCurrentState);

  for (const metricKey of Object.keys(CURRENT_STATE_FIELD_BY_KEY)) {
    const field = CURRENT_STATE_FIELD_BY_KEY[metricKey];
    const label = METRIC_BY_KEY.get(metricKey)!.label;
    const valueOf = (p: (typeof eligible)[number]) => {
      const raw = p[field];
      return raw !== null ? Number(raw) : 0;
    };

    // No locked-semantics target exists for these metrics -- store null,
    // never a fabricated placeholder (the column is nullable for exactly
    // this reason).
    const targetValue: number | null = null;

    await upsertSnapshot({
      metricName: label,
      territoryId: null,
      periodStart,
      periodEnd,
      currentValue: eligible.reduce((sum, p) => sum + valueOf(p), 0),
      targetValue,
    });

    for (const t of territories) {
      const scoped = eligible.filter((p) => p.territoryId === t.id);
      await upsertSnapshot({
        metricName: label,
        territoryId: t.id,
        periodStart,
        periodEnd,
        currentValue: scoped.reduce((sum, p) => sum + valueOf(p), 0),
        targetValue,
      });
    }
  }
}
