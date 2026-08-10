// Stage 6.2: PAM-scoped Team/My Targets. Deliberately thin -- the only new
// logic here is target CRUD validation and assembling the PAM x metric
// grid; actual-value computation is never duplicated, it always calls
// kpiService.computeMetric (the exact function Overview/exports/AI brief
// already use).
import { db } from "@workspace/db";
import { metricTargetsTable, territoriesTable, usersTable, type MetricTarget } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { METRIC_BY_KEY, TARGETABLE_METRIC_KEYS, isTargetableMetric, splitPeriodKey } from "./kpiRegistry";
import { computeMetric } from "./kpiService";

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

// Single atomic upsert (onConflictDoUpdate on the canonical
// metric_key+period+pam_user_id+territory_id uniqueness) -- same
// no-race-window convention used throughout this codebase.
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

  const [saved] = await db
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

  return saved!;
}

export async function deleteTarget(id: string): Promise<MetricTarget | null> {
  const [existing] = await db.select().from(metricTargetsTable).where(eq(metricTargetsTable.id, id));
  if (!existing) return null;
  await db.delete(metricTargetsTable).where(eq(metricTargetsTable.id, id));
  return existing;
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
