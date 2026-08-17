// Stage 6.2: PAM-scoped Team/My Targets. Deliberately thin -- the only new
// logic here is target CRUD validation and assembling the PAM x metric
// grid; actual-value computation is never duplicated, it always calls
// kpiService.computeMetric (the exact function Overview/exports/AI brief
// already use).
import { db } from "@workspace/db";
import { metricTargetsTable, territoriesTable, usersTable, partnerOpportunitiesTable, type MetricTarget } from "@workspace/db";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { METRIC_BY_KEY, TARGETABLE_METRIC_KEYS, isTargetableMetric, splitPeriodKey, joinPeriodKey, resolvePeriodRange } from "./kpiRegistry";
import { computeMetric, buildUsdRateMap, usdValueOf } from "./kpiService";
import { recordChannelChangeEvent } from "./channelChangeEventsService";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class TargetNotTargetableError extends Error {}
export class TargetInvalidPeriodError extends Error {}
export class TargetTerritoryNotFoundError extends Error {}
export class TargetPamNotFoundError extends Error {}
export class TargetPamTerritoryMismatchError extends Error {}
export class TargetNotFoundError extends Error {}

export interface UpsertTargetInput {
  metricKey: string;
  periodKey: string;
  territoryId: string;
  pamUserId: string;
  targetValue: number;
  note: string | null;
  actingUserId: string;
}

// Validates the (pam_user_id, territory_id) pair is a real canonical
// ownership match (territories.owner_user_id) before writing -- the only
// place this is checked, reused by both the create/update path here.
// Never lets a mismatched pair reach the database.
async function assertPamOwnsTerritory(territoryId: string, pamUserId: string): Promise<{ territoryName: string; pamName: string }> {
  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, territoryId));
  if (!territory) throw new TargetTerritoryNotFoundError("Territory not found.");

  const [pam] = await db.select().from(usersTable).where(eq(usersTable.id, pamUserId));
  if (!pam) throw new TargetPamNotFoundError("PAM not found.");

  if (territory.ownerUserId !== pamUserId) {
    throw new TargetPamTerritoryMismatchError(
      `${pam.name} does not canonically own ${territory.name}. Change territory ownership first (Settings > Team) before assigning this target.`,
    );
  }

  return { territoryName: territory.name, pamName: pam.name };
}

// The only two fields a target upsert can actually change (targetValue,
// note) -- everything else on the row is identity (metric_key/year/period/
// pam_user_id/territory_id, which the unique index guarantees can never
// differ between "before" and "after" for the same upsert) or audit
// metadata (created_by/updated_by/timestamps), neither of which belongs in
// a "what changed" diff. Exported so this exact business-value shape is
// independently unit-testable.
export interface TargetMaterialValues {
  target_value: number;
  note: string | null;
}

function materialTargetValues(row: Pick<MetricTarget, "targetValue" | "note">): TargetMaterialValues {
  return { target_value: Number(row.targetValue), note: row.note };
}

// Pure, DB-free: null before -> always material (a target now exists where
// none did, old_values null). Otherwise returns null (no event) when
// target_value AND note are both unchanged -- an upsert that re-saves the
// exact same values (e.g. a no-op form submit) must never fabricate a
// "material change" event for Aniri to later notify Irina about.
export function diffTargetValues(
  before: TargetMaterialValues | null,
  after: TargetMaterialValues,
): { oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> } | null {
  if (!before) return { oldValues: null, newValues: { ...after } };
  if (before.target_value === after.target_value && before.note === after.note) return null;
  return { oldValues: { ...before }, newValues: { ...after } };
}

// Concurrency: guarded by a transaction-scoped Postgres advisory lock keyed
// on the exact upsert identity (metric_key+year+period+pam_user_id+
// territory_id) -- same pattern as discoveryEngine.ts's
// resolveOrCreateCanonicalCompany. The pre-image SELECT below has nothing
// to lock when no row exists yet, so without this, two concurrent upserts
// for a brand-new key could both see "no existing row" under READ
// COMMITTED; the loser's audit event would then be falsely recorded as
// "created" with old_values null even though the winner's row (and its own
// prior values) already exist. The lock forces the second transaction to
// block until the first commits, so its own SELECT always sees the
// winner's already-committed row -- old_values/eventType stay truthful,
// and the metric_target_*_unique constraint itself is untouched.
async function lockTargetUpsertKey(tx: Tx, metricKey: string, year: number, period: string, pamUserId: string | null, territoryId: string | null): Promise<void> {
  const key = `metric_target:${metricKey}:${year}:${period}:${pamUserId ?? ""}:${territoryId ?? ""}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key})::bigint)`);
}

// Single atomic upsert (onConflictDoUpdate on the canonical
// metric_key+period+pam_user_id+territory_id uniqueness) -- same
// no-race-window convention used throughout this codebase. Phase 11.6.1:
// the pre-image SELECT, the upsert, and the conditional channel_change_events
// insert now all run inside one transaction, so the business write and its
// change event are atomic -- a failure anywhere rolls both back together,
// and a reader of channel_change_events can never observe a target write
// that didn't actually happen (or vice versa).
export async function upsertTarget(input: UpsertTargetInput): Promise<MetricTarget> {
  if (!isTargetableMetric(input.metricKey)) {
    throw new TargetNotTargetableError(`"${input.metricKey}" is not a targetable metric.`);
  }
  const split = splitPeriodKey(input.periodKey);
  if (!split) throw new TargetInvalidPeriodError(`Invalid period: ${input.periodKey}`);
  await assertPamOwnsTerritory(input.territoryId, input.pamUserId);

  const now = new Date();
  const values = {
    metricKey: input.metricKey,
    year: split.year,
    period: split.quarterKey,
    territoryId: input.territoryId,
    pamUserId: input.pamUserId,
    targetValue: String(input.targetValue),
    note: input.note,
    createdByUserId: input.actingUserId,
    updatedByUserId: input.actingUserId,
    updatedAt: now,
  };

  return db.transaction(async (tx) => {
    await lockTargetUpsertKey(tx, values.metricKey, values.year, values.period, values.pamUserId, values.territoryId);

    const [existing] = await tx
      .select()
      .from(metricTargetsTable)
      .where(
        and(
          eq(metricTargetsTable.metricKey, values.metricKey),
          eq(metricTargetsTable.year, values.year),
          eq(metricTargetsTable.period, values.period),
          eq(metricTargetsTable.pamUserId, values.pamUserId),
          eq(metricTargetsTable.territoryId, values.territoryId),
        ),
      );

    const [saved] = await tx
      .insert(metricTargetsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          metricTargetsTable.metricKey,
          metricTargetsTable.year,
          metricTargetsTable.period,
          metricTargetsTable.pamUserId,
          metricTargetsTable.territoryId,
        ],
        set: { targetValue: values.targetValue, note: values.note, updatedByUserId: values.updatedByUserId, updatedAt: values.updatedAt },
      })
      .returning();

    const diff = diffTargetValues(existing ? materialTargetValues(existing) : null, materialTargetValues(saved!));
    if (diff) {
      await recordChannelChangeEvent(tx, {
        entityType: "metric_target",
        entityId: saved!.id,
        eventType: existing ? "updated" : "created",
        actorUserId: input.actingUserId,
        occurredAt: now,
        oldValues: diff.oldValues,
        newValues: diff.newValues,
        metadata: { metric_key: values.metricKey, year: values.year, period: values.period, pam_user_id: values.pamUserId, territory_id: values.territoryId },
      });
    }

    return saved!;
  });
}

// A single DELETE ... RETURNING, not a separate pre-image SELECT followed
// by a DELETE: Postgres row-level locking makes this atomically race-safe
// on its own -- if two callers race to delete the same id, only the
// statement that actually removes the row gets rows back from RETURNING.
// The loser's DELETE affects zero rows (the row is already gone by the
// time it runs), so `deleted` is undefined here and it correctly reports
// "not found" (null) rather than false success, and never records a
// second, duplicate "deleted" channel_change_events row for a delete that
// didn't actually happen.
export async function deleteTarget(id: string, actingUserId: string): Promise<MetricTarget | null> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx.delete(metricTargetsTable).where(eq(metricTargetsTable.id, id)).returning();
    if (!deleted) return null;
    await recordChannelChangeEvent(tx, {
      entityType: "metric_target",
      entityId: id,
      eventType: "deleted",
      actorUserId: actingUserId,
      oldValues: { ...materialTargetValues(deleted) },
      newValues: null,
      metadata: {
        metric_key: deleted.metricKey,
        year: deleted.year,
        period: deleted.period,
        pam_user_id: deleted.pamUserId,
        territory_id: deleted.territoryId,
      },
    });
    return deleted;
  });
}

export interface TeamTargetRow {
  pam_user_id: string;
  pam_name: string;
  territory_id: string;
  territory_name: string;
  metric_key: string;
  metric_label: string;
  target_value: number | null;
  target_id: string | null;
  actual_value: number | null;
  progress_percent: number | null;
  status: "ahead" | "behind" | "no_target";
}

export interface TargetProgress {
  progress_percent: number | null;
  status: "ahead" | "behind" | "no_target";
}

// Pure, DB-free -- the exact boundary logic Team Targets/My Targets rely
// on, split out so it's unit-testable without a live DB. null target ->
// "no_target" (never treated as a target of 0); reaching or exceeding the
// target is "ahead", anything else "behind"; progress_percent stays null
// whenever there's no target to measure against (never computed as if
// target were 0, which would divide by zero / be meaningless).
export function computeTargetProgress(actualValue: number | null, targetValue: number | null): TargetProgress {
  if (targetValue === null) return { progress_percent: null, status: "no_target" };
  const progressPercent = targetValue > 0 && actualValue !== null ? Math.round((actualValue / targetValue) * 100) : null;
  const status: TargetProgress["status"] = (actualValue ?? 0) >= targetValue ? "ahead" : "behind";
  return { progress_percent: progressPercent, status };
}

export interface TeamTargetsScope {
  // Head/Admin only -- a PAM's own scope is always forced to their own
  // (territory, pam) pair by the caller (routes/targets.ts), never these.
  pamUserId?: string | null;
  territoryId?: string | null;
}

// Builds the PAM x targetable-metric grid for a period -- one row per
// (canonically-owned territory, targetable metric), including rows with no
// target configured yet (target_value/target_id null), so Team Targets can
// offer "create a missing target" directly from this same list. Actual
// values always come from kpiService.computeMetric -- never recomputed
// here.
export async function getTeamTargets(periodKey: string, scope: TeamTargetsScope = {}): Promise<TeamTargetRow[]> {
  const split = splitPeriodKey(periodKey);
  if (!split) throw new TargetInvalidPeriodError(`Invalid period: ${periodKey}`);

  const [allTerritories, allUsers, allTargets] = await Promise.all([
    db.select().from(territoriesTable),
    db.select().from(usersTable),
    db
      .select()
      .from(metricTargetsTable)
      .where(and(eq(metricTargetsTable.year, split.year), eq(metricTargetsTable.period, split.quarterKey))),
  ]);
  const userById = new Map(allUsers.map((u) => [u.id, u]));

  let ownedTerritories = allTerritories.filter((t) => t.ownerUserId !== null);
  if (scope.territoryId) ownedTerritories = ownedTerritories.filter((t) => t.id === scope.territoryId);
  if (scope.pamUserId) ownedTerritories = ownedTerritories.filter((t) => t.ownerUserId === scope.pamUserId);

  const rows: TeamTargetRow[] = [];
  for (const territory of ownedTerritories) {
    const pam = userById.get(territory.ownerUserId!);
    if (!pam) continue; // stale FK -- stay honest, skip rather than fabricate a name

    for (const metricKey of TARGETABLE_METRIC_KEYS) {
      const metricDef = METRIC_BY_KEY.get(metricKey)!;
      const targetRow = allTargets.find(
        (t) => t.metricKey === metricKey && t.territoryId === territory.id && t.pamUserId === pam.id,
      );
      const targetValue = targetRow ? Number(targetRow.targetValue) : null;

      const computation = await computeMetric(metricKey, periodKey, { territoryId: territory.id, territoryName: territory.name });
      const actualValue = computation.current;
      const { progress_percent: progressPercent, status } = computeTargetProgress(actualValue, targetValue);

      rows.push({
        pam_user_id: pam.id,
        pam_name: pam.name,
        territory_id: territory.id,
        territory_name: territory.name,
        metric_key: metricKey,
        metric_label: metricDef.label,
        target_value: targetValue,
        target_id: targetRow?.id ?? null,
        actual_value: actualValue,
        progress_percent: progressPercent,
        status,
      });
    }
  }

  return rows;
}

// ---- Phase 5A: company-wide annual target + PAM allocation cascade --------
//
// "annual" is a genuine third target-period value, distinct from the q1-q4
// quarterly rows above and never overloading "ytd" (which stays a pure
// reporting-period concept in kpiRegistry.ts/kpiService.ts -- resolving an
// *actual* value for the whole year to date, never a *target*). An annual
// row always has pam_user_id = territory_id = null (company-wide, Head/
// Admin-owned) -- enforced by the DB's metric_targets_global_annual_unique
// partial index (see lib/db/src/schema/metric_targets.ts for why the plain
// 5-column unique index can't reliably do this for null-owner rows), not
// just by this function only ever constructing null-owner values.

export interface UpsertAnnualTargetInput {
  metricKey: string;
  year: number;
  targetValue: number;
  note: string | null;
  actingUserId: string;
}

// Single atomic upsert, same onConflictDoUpdate convention as upsertTarget
// above -- targetWhere is required here because the conflict target is a
// *partial* unique index (metric_key, year) WHERE ... , not a plain
// multi-column one; Postgres needs the same predicate repeated in the
// ON CONFLICT clause to know which index this write is targeting.
export async function upsertAnnualTarget(input: UpsertAnnualTargetInput): Promise<MetricTarget> {
  if (!isTargetableMetric(input.metricKey)) {
    throw new TargetNotTargetableError(`"${input.metricKey}" is not a targetable metric.`);
  }

  const now = new Date();
  const values = {
    metricKey: input.metricKey,
    year: input.year,
    period: "annual",
    territoryId: null,
    pamUserId: null,
    targetValue: String(input.targetValue),
    note: input.note,
    createdByUserId: input.actingUserId,
    updatedByUserId: input.actingUserId,
    updatedAt: now,
  };

  return db.transaction(async (tx) => {
    await lockTargetUpsertKey(tx, values.metricKey, values.year, "annual", null, null);

    const [existing] = await tx
      .select()
      .from(metricTargetsTable)
      .where(
        and(
          eq(metricTargetsTable.metricKey, values.metricKey),
          eq(metricTargetsTable.year, values.year),
          eq(metricTargetsTable.period, "annual"),
          isNull(metricTargetsTable.pamUserId),
          isNull(metricTargetsTable.territoryId),
        ),
      );

    const [saved] = await tx
      .insert(metricTargetsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [metricTargetsTable.metricKey, metricTargetsTable.year],
        targetWhere: sql`${metricTargetsTable.pamUserId} is null and ${metricTargetsTable.territoryId} is null and ${metricTargetsTable.period} = 'annual'`,
        set: { targetValue: values.targetValue, note: values.note, updatedByUserId: values.updatedByUserId, updatedAt: values.updatedAt },
      })
      .returning();

    const diff = diffTargetValues(existing ? materialTargetValues(existing) : null, materialTargetValues(saved!));
    if (diff) {
      await recordChannelChangeEvent(tx, {
        entityType: "metric_target",
        entityId: saved!.id,
        eventType: existing ? "updated" : "created",
        actorUserId: input.actingUserId,
        occurredAt: now,
        oldValues: diff.oldValues,
        newValues: diff.newValues,
        metadata: { metric_key: values.metricKey, year: values.year, period: "annual", pam_user_id: null, territory_id: null },
      });
    }

    return saved!;
  });
}

export async function getAnnualTarget(metricKey: string, year: number): Promise<MetricTarget | null> {
  const [row] = await db
    .select()
    .from(metricTargetsTable)
    .where(
      and(
        eq(metricTargetsTable.metricKey, metricKey),
        eq(metricTargetsTable.year, year),
        eq(metricTargetsTable.period, "annual"),
        isNull(metricTargetsTable.pamUserId),
        isNull(metricTargetsTable.territoryId),
      ),
    );
  return row ?? null;
}

export interface PamAllocation {
  pamUserId: string;
  pamName: string;
  territoryId: string;
  territoryName: string;
  q1: number | null;
  q2: number | null;
  q3: number | null;
  q4: number | null;
}

export interface QuarterlyAllocationTotals {
  q1: number;
  q2: number;
  q3: number;
  q4: number;
}

export interface AnnualCascade {
  metric_key: string;
  year: number;
  annual_target: number | null;
  allocated_to_pams: number;
  // null only when there's no annual_target to measure against -- never a
  // fabricated 0. Otherwise always >= 0: any excess over target is
  // reported via overallocated_amount instead, never a negative number
  // here.
  unallocated_amount: number | null;
  overallocated_amount: number;
  quarterly_totals: QuarterlyAllocationTotals;
  actual: number | null;
  attainment_percent: number | null;
  allocations: PamAllocation[];
}

// Pure, DB-free -- the actual cascade math, unit-testable without a live
// DB. Deliberately never divides the annual target by four (see the
// Phase 5A brief) -- allocated_to_pams is whatever the PAMs' own q1-q4 rows
// sum to, independent of what the annual figure is; the gap/excess between
// the two is exactly what unallocated_amount/overallocated_amount surface.
// A PAM's unset quarter is treated as 0 for summation (never as "no data"
// that would otherwise skew the total), matching the existing
// computeTargetProgress convention of never treating an absence as a
// fabricated non-zero value.
export function computeAnnualCascade(
  metricKey: string,
  year: number,
  annualTarget: number | null,
  allocations: ReadonlyArray<PamAllocation>,
  actual: number | null,
): AnnualCascade {
  const sumOfQuarter = (q: "q1" | "q2" | "q3" | "q4") => allocations.reduce((sum, a) => sum + (a[q] ?? 0), 0);
  const quarterly_totals: QuarterlyAllocationTotals = {
    q1: sumOfQuarter("q1"),
    q2: sumOfQuarter("q2"),
    q3: sumOfQuarter("q3"),
    q4: sumOfQuarter("q4"),
  };
  const allocated_to_pams = quarterly_totals.q1 + quarterly_totals.q2 + quarterly_totals.q3 + quarterly_totals.q4;

  const unallocated_amount = annualTarget !== null ? Math.max(0, annualTarget - allocated_to_pams) : null;
  const overallocated_amount = Math.max(0, allocated_to_pams - (annualTarget ?? 0));
  const attainment_percent =
    annualTarget !== null && annualTarget > 0 && actual !== null ? Math.round((actual / annualTarget) * 100) : null;

  return {
    metric_key: metricKey,
    year,
    annual_target: annualTarget,
    allocated_to_pams,
    unallocated_amount,
    overallocated_amount,
    quarterly_totals,
    actual,
    attainment_percent,
    allocations: [...allocations],
  };
}

const TARGET_QUARTER_KEYS = ["q1", "q2", "q3", "q4"] as const;
type TargetQuarterKey = (typeof TARGET_QUARTER_KEYS)[number];
function isTargetQuarterKey(period: string): period is TargetQuarterKey {
  return (TARGET_QUARTER_KEYS as readonly string[]).includes(period);
}

// The "actual" figure an annual target is measured against. For every
// metric except closed_revenue this is just the existing YTD reporting
// computation (computeMetric) -- never recomputed here, same "never a
// second source of truth" convention as getTeamTargets above. closed_revenue
// is the deliberate exception: per the historical-cutover model, target
// attainment is a credit-aware figure -- credit_value/credit_date when
// present on a won opportunity, otherwise its true deal_value/closed_at --
// which can legitimately differ from the closed_revenue *reporting* KPI
// (computeClosedRevenue in kpiService.ts, which always uses the true
// deal_value/closed_at only, never credit_value/credit_date). A 2025
// contract validly credited to the 2026 target contributes here without
// ever appearing as 2026 closed revenue in the KPI report, and closed_at is
// never touched to make that happen. credit_value, when set, is assumed to
// be denominated in that same row's own `currency` column (there is no
// separate credit currency field) before USD normalization.
async function computeAnnualActual(metricKey: string, year: number): Promise<number | null> {
  if (metricKey !== "closed_revenue") {
    const computation = await computeMetric(metricKey, joinPeriodKey(year, "ytd"), { territoryId: null, territoryName: "Global" });
    return computation.current;
  }

  const periodInfo = resolvePeriodRange(joinPeriodKey(year, "ytd"));
  const won = await db.select().from(partnerOpportunitiesTable).where(eq(partnerOpportunitiesTable.status, "won"));

  const creditedDateStr = (o: (typeof won)[number]): string | null => {
    if (o.creditDate) return o.creditDate;
    return o.closedAt ? new Date(o.closedAt as unknown as string).toISOString().slice(0, 10) : null;
  };
  const eligible = won.filter((o) => {
    const dateStr = creditedDateStr(o);
    return dateStr !== null && dateStr >= periodInfo.start && dateStr <= periodInfo.end;
  });

  const rateByCurrency = await buildUsdRateMap(eligible.map((o) => o.currency));
  const creditedValueOf = (o: (typeof eligible)[number]) =>
    o.creditValue !== null ? Number(o.creditValue) / (rateByCurrency.get(o.currency) ?? 1) : usdValueOf(o, rateByCurrency);

  return eligible.reduce((sum, o) => sum + creditedValueOf(o), 0);
}

// DB-backed orchestrator: fetches the annual target row, every PAM's q1-q4
// allocation rows for this metric+year, and the actual company-wide
// year-to-date performance -- then hands everything to the pure function.
// "Actual" is always measured through the whole-year-to-date window
// (periodKey "<year>-ytd" semantics, Global scope), matching what an annual
// target is naturally compared against; see computeAnnualActual above for
// the closed_revenue credit-aware exception.
export async function getAnnualCascade(metricKey: string, year: number): Promise<AnnualCascade> {
  if (!isTargetableMetric(metricKey)) {
    throw new TargetNotTargetableError(`"${metricKey}" is not a targetable metric.`);
  }

  const [annualRow, quarterRows, allTerritories, allUsers, actual] = await Promise.all([
    getAnnualTarget(metricKey, year),
    db
      .select()
      .from(metricTargetsTable)
      .where(and(eq(metricTargetsTable.metricKey, metricKey), eq(metricTargetsTable.year, year), inArray(metricTargetsTable.period, TARGET_QUARTER_KEYS))),
    db.select().from(territoriesTable),
    db.select().from(usersTable),
    computeAnnualActual(metricKey, year),
  ]);

  const userById = new Map(allUsers.map((u) => [u.id, u]));

  // Seed one allocation entry per canonically-owned territory -- same
  // ownership-enumeration pattern getTeamTargets already uses above (filter
  // territories.owner_user_id !== null, skip a stale FK rather than
  // fabricate a name) -- so a PAM who owns a territory but has never had a
  // quarter target row saved for this metric+year still appears, with all
  // four quarters honestly null, instead of being invisible to the cascade.
  const byPamTerritory = new Map<string, PamAllocation>();
  for (const territory of allTerritories) {
    if (!territory.ownerUserId) continue;
    const pam = userById.get(territory.ownerUserId);
    if (!pam) continue; // stale FK -- stay honest, skip rather than fabricate a name
    const key = `${territory.ownerUserId}|${territory.id}`;
    byPamTerritory.set(key, {
      pamUserId: territory.ownerUserId,
      pamName: pam.name,
      territoryId: territory.id,
      territoryName: territory.name,
      q1: null,
      q2: null,
      q3: null,
      q4: null,
    });
  }

  // Overlay any existing quarter rows onto the seeded allocations above.
  for (const row of quarterRows) {
    // Only real PAM+territory rows participate in the cascade -- a
    // malformed/legacy row missing either is excluded rather than
    // half-attributed. A row whose (pam, territory) pair is no longer a
    // canonical ownership match (e.g. ownership since reassigned) has no
    // seeded entry to overlay onto and is likewise skipped here -- it never
    // fabricates a new allocation entry outside the ownership enumeration
    // above.
    if (!row.pamUserId || !row.territoryId || !isTargetQuarterKey(row.period)) continue;
    const key = `${row.pamUserId}|${row.territoryId}`;
    const entry = byPamTerritory.get(key);
    if (!entry) continue;
    entry[row.period] = Number(row.targetValue);
  }

  const annualTarget = annualRow ? Number(annualRow.targetValue) : null;
  return computeAnnualCascade(metricKey, year, annualTarget, [...byPamTerritory.values()], actual);
}
