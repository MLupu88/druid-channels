import { db } from "@workspace/db";
import {
  territoriesTable,
  prospectsTable,
  campaignsTable,
  kpiSnapshotsTable,
  metricMappingsTable,
  manualMetricValuesTable,
  connectionsTable,
} from "@workspace/db";
import { eq, and, isNull, gte, lte, inArray } from "drizzle-orm";
import { METRIC_BY_KEY, METRIC_REGISTRY, PERIODS, resolvePeriodKey, type SourceType } from "./kpiRegistry";
import { hasCredential } from "./connections";

export type DataStatus = "CONNECTED" | "MANUAL" | "DEMO" | "NOT_CONNECTED";
export type MappingStatus = "connected" | "needs_mapping" | "not_connected" | "demo";

export interface TerritoryContribution {
  territory_id: string | null;
  territory_name: string;
  value: number;
}

export interface KpiDetailRecord {
  label: string;
  value: number;
  date: string | null;
}

export interface ResolvedTerritory {
  territoryId: string | null;
  territoryName: string;
}

export interface KpiComputation {
  current: number | null;
  target: number | null;
  last_week: number | null;
  trend: "up" | "down" | "flat" | null;
  status: "green" | "amber" | "red" | "on_track" | null;
  data_status: DataStatus;
  data_source: string | null;
  last_updated: string | null;
  what_changed: string | null;
  explanation: string | null;
  by_territory: TerritoryContribution[];
  records: KpiDetailRecord[];
}

export async function ensureMetricMappingsSeeded(): Promise<void> {
  const existing = await db.select().from(metricMappingsTable);
  const existingKeys = new Set(existing.map((m) => m.metricKey));
  const missing = METRIC_REGISTRY.filter((m) => !existingKeys.has(m.key));
  if (missing.length === 0) return;
  await db.insert(metricMappingsTable).values(
    missing.map((m) => ({
      metricKey: m.key,
      sourceType: m.defaultSourceType,
      active: true,
      mappingJson: null,
    })),
  );
}

export async function resolveTerritory(territory: string | undefined | null): Promise<ResolvedTerritory> {
  const isGlobalRequest = !territory || ["global", "Global", "null", "undefined"].includes(territory);
  if (isGlobalRequest) return { territoryId: null, territoryName: "Global" };

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(territory);
  const [terr] = await db
    .select()
    .from(territoriesTable)
    .where(isUuid ? eq(territoriesTable.id, territory) : eq(territoriesTable.name, territory));
  if (terr) return { territoryId: terr.id, territoryName: terr.name };
  return { territoryId: null, territoryName: "Global" };
}

function trendOf(current: number, previous: number): "up" | "down" | "flat" {
  return current > previous ? "up" : current < previous ? "down" : "flat";
}

const NEW_PROSPECT_TARGETS: Record<string, number> = { q1: 8, q2: 11, q3: 15, q4: 18, ytd: 40 };

async function computePartnerRadar(periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = PERIODS[periodKey];
  const allTerritories = await db.select().from(territoriesTable);
  const allProspects = await db.select().from(prospectsTable);

  const periodStartMs = new Date(periodInfo.start).getTime();
  const periodEndMs = new Date(periodInfo.end + "T23:59:59.999Z").getTime();
  const inPeriod = allProspects.filter((p) => {
    const createdMs = new Date(p.createdAt as unknown as string).getTime();
    return createdMs >= periodStartMs && createdMs <= periodEndMs;
  });

  const isCountable = (p: (typeof inPeriod)[number]) =>
    p.status === "new" || p.status === "accepted" || p.status === "pushed_to_hubspot";

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: inPeriod.filter((p) => p.territoryId === t.id && isCountable(p)).length,
  }));

  const scoped = target.territoryId ? inPeriod.filter((p) => p.territoryId === target.territoryId) : inPeriod;
  const newCount = scoped.filter((p) => p.status === "new").length;
  const acceptedCount = scoped.filter((p) => p.status === "accepted").length;
  const pushedCount = scoped.filter((p) => p.status === "pushed_to_hubspot").length;
  const rejectedCount = scoped.filter((p) => p.status === "rejected").length;
  const total = newCount + acceptedCount + pushedCount;
  const targetValue = NEW_PROSPECT_TARGETS[periodKey] ?? 15;
  const mostRecent = scoped.reduce<Date | null>((latest, p) => {
    const created = new Date(p.createdAt as unknown as string);
    return !latest || created > latest ? created : latest;
  }, null);

  const records: KpiDetailRecord[] = scoped
    .filter(isCountable)
    .slice(0, 100)
    .map((p) => ({ label: `Prospect ${p.id.slice(0, 8)} (${p.status})`, value: 1, date: new Date(p.createdAt as unknown as string).toISOString() }));

  return {
    current: total,
    target: targetValue,
    last_week: null,
    trend: null,
    status: total >= targetValue ? "green" : total >= targetValue * 0.7 ? "amber" : "red",
    data_status: "CONNECTED",
    data_source: "Live: prospects table, scoped to prospects created within the selected period",
    last_updated: (mostRecent ?? new Date()).toISOString(),
    what_changed: `${acceptedCount} accepted, ${newCount} awaiting review, ${rejectedCount} rejected`,
    explanation: `${acceptedCount} accepted and ${newCount} awaiting review, out of ${scoped.length} discovered in ${periodInfo.label} for ${target.territoryName}. ${rejectedCount} were rejected as not a fit.`,
    by_territory: byTerritory,
    records,
  };
}

function weekWindow(now: Date) {
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const thisWeekEnd = startOfDay(now);
  const thisWeekStart = new Date(thisWeekEnd);
  thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - 6);
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() - 1);
  const lastWeekStart = new Date(lastWeekEnd);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 6);
  return { thisWeekStart, thisWeekEnd, lastWeekStart, lastWeekEnd };
}

const ACTIVITY_FIELD_BY_KEY: Record<string, { kind: "count"; type: string } | { kind: "sum"; field: "mqls" | "partnerReferrals" }> = {
  joint_campaigns: { kind: "count", type: "joint_campaign" },
  events: { kind: "count", type: "event" },
  webinars: { kind: "count", type: "webinar" },
  marketing_qualified_leads: { kind: "sum", field: "mqls" },
  partner_referrals: { kind: "sum", field: "partnerReferrals" },
};

async function computeActivities(metricKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const now = new Date();
  const { thisWeekStart, thisWeekEnd, lastWeekStart, lastWeekEnd } = weekWindow(now);
  const toDateStr = (d: Date) => d.toISOString().slice(0, 10);
  const allTerritories = await db.select().from(territoriesTable);

  const twoWeekFilter = and(gte(campaignsTable.activityDate, toDateStr(lastWeekStart)), lte(campaignsTable.activityDate, toDateStr(thisWeekEnd)));
  const rows = await db.select().from(campaignsTable).where(twoWeekFilter);

  const inWindow = (dateStr: string | null, start: Date, end: Date) =>
    dateStr !== null && dateStr >= toDateStr(start) && dateStr <= toDateStr(end);

  const field = ACTIVITY_FIELD_BY_KEY[metricKey];
  const valueOf = (subset: typeof rows) => {
    if (field.kind === "count") return subset.filter((r) => r.type === field.type).length;
    return subset.reduce((sum, r) => sum + r[field.field], 0);
  };

  const thisWeekAll = rows.filter((r) => inWindow(r.activityDate, thisWeekStart, thisWeekEnd));
  const lastWeekAll = rows.filter((r) => inWindow(r.activityDate, lastWeekStart, lastWeekEnd));

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => ({
    territory_id: t.id,
    territory_name: t.name,
    value: valueOf(thisWeekAll.filter((r) => r.territory === t.name)),
  }));

  const scopedThisWeek = target.territoryId
    ? thisWeekAll.filter((r) => r.territory === target.territoryName)
    : thisWeekAll;
  const scopedLastWeek = target.territoryId
    ? lastWeekAll.filter((r) => r.territory === target.territoryName)
    : lastWeekAll;

  const thisWeekValue = valueOf(scopedThisWeek);
  const lastWeekValue = valueOf(scopedLastWeek);
  const label = METRIC_BY_KEY.get(metricKey)!.label;

  const records: KpiDetailRecord[] = scopedThisWeek
    .filter((r) => (field.kind === "count" ? r.type === field.type : true))
    .slice(0, 100)
    .map((r) => ({
      label: r.name,
      value: field.kind === "count" ? 1 : r[field.field],
      date: r.activityDate,
    }));

  return {
    current: thisWeekValue,
    target: null,
    last_week: lastWeekValue,
    trend: trendOf(thisWeekValue, lastWeekValue),
    status: null,
    data_status: "CONNECTED",
    data_source: `Live: activities table, calendar week ${toDateStr(thisWeekStart)} to ${toDateStr(thisWeekEnd)} vs prior week`,
    last_updated: now.toISOString(),
    what_changed: null,
    explanation: `${thisWeekValue} ${label.toLowerCase()} this week for ${target.territoryName}, vs ${lastWeekValue} last week.`,
    by_territory: byTerritory,
    records,
  };
}

async function computeDemo(metricKey: string, periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const periodInfo = PERIODS[periodKey];
  const label = METRIC_BY_KEY.get(metricKey)!.label;
  const allTerritories = await db.select().from(territoriesTable);

  const territoryRows = await db
    .select()
    .from(kpiSnapshotsTable)
    .where(and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), eq(kpiSnapshotsTable.metricName, label), inArray(kpiSnapshotsTable.territoryId, allTerritories.map((t) => t.id))));

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => {
    const row = territoryRows.find((r) => r.territoryId === t.id);
    return { territory_id: t.id, territory_name: t.name, value: row ? Number(row.currentValue) : 0 };
  });

  const scopeWhere = target.territoryId
    ? and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), eq(kpiSnapshotsTable.metricName, label), eq(kpiSnapshotsTable.territoryId, target.territoryId))
    : and(eq(kpiSnapshotsTable.periodStart, periodInfo.start), eq(kpiSnapshotsTable.metricName, label), isNull(kpiSnapshotsTable.territoryId));
  const [snapshot] = await db.select().from(kpiSnapshotsTable).where(scopeWhere);

  if (!snapshot) {
    return {
      current: null,
      target: null,
      last_week: null,
      trend: null,
      status: null,
      data_status: "NOT_CONNECTED",
      data_source: null,
      last_updated: null,
      what_changed: null,
      explanation: `No demo snapshot exists yet for ${label} in ${periodInfo.label}.`,
      by_territory: byTerritory,
      records: [],
    };
  }

  const current = Number(snapshot.currentValue);
  const lastWeek = snapshot.lastWeekValue !== null ? Number(snapshot.lastWeekValue) : null;

  return {
    current,
    target: Number(snapshot.targetValue),
    last_week: lastWeek,
    trend: lastWeek !== null ? trendOf(current, lastWeek) : null,
    status: snapshot.status,
    data_status: "DEMO",
    data_source: "Demo data: seeded quarterly snapshot (not a live CRM sync)",
    last_updated: snapshot.createdAt.toISOString(),
    what_changed: snapshot.whatChanged,
    explanation: snapshot.explanation,
    by_territory: byTerritory,
    records: [],
  };
}

async function computeManual(metricKey: string, periodKey: string, target: ResolvedTerritory): Promise<KpiComputation> {
  const rows = await db.select().from(manualMetricValuesTable).where(eq(manualMetricValuesTable.metricKey, metricKey));
  const periodRows = rows.filter((r) => r.period === periodKey);
  const allTerritories = await db.select().from(territoriesTable);

  const byTerritory: TerritoryContribution[] = allTerritories.map((t) => {
    const row = periodRows.find((r) => r.territoryId === t.id);
    return { territory_id: t.id, territory_name: t.name, value: row ? Number(row.currentValue) : 0 };
  });

  const match = target.territoryId
    ? periodRows.find((r) => r.territoryId === target.territoryId)
    : periodRows.find((r) => r.territoryId === null);

  if (!match) {
    return {
      current: null,
      target: null,
      last_week: null,
      trend: null,
      status: null,
      data_status: "NOT_CONNECTED",
      data_source: null,
      last_updated: null,
      what_changed: null,
      explanation: `No manual value has been entered yet for this metric/period/territory.`,
      by_territory: byTerritory,
      records: [],
    };
  }

  return {
    current: Number(match.currentValue),
    target: match.targetValue !== null ? Number(match.targetValue) : null,
    last_week: null,
    trend: null,
    status: null,
    data_status: "MANUAL",
    data_source: "Manual entry (Admin > Connections & data > Metric setup)",
    last_updated: match.updatedAt.toISOString(),
    what_changed: null,
    explanation: match.note,
    by_territory: byTerritory,
    records: [],
  };
}

function notConnected(reason: string): KpiComputation {
  return {
    current: null,
    target: null,
    last_week: null,
    trend: null,
    status: null,
    data_status: "NOT_CONNECTED",
    data_source: null,
    last_updated: null,
    what_changed: null,
    explanation: reason,
    by_territory: [],
    records: [],
  };
}

export async function getEffectiveMapping(metricKey: string) {
  const [mapping] = await db.select().from(metricMappingsTable).where(eq(metricMappingsTable.metricKey, metricKey));
  if (mapping) return mapping;
  const def = METRIC_BY_KEY.get(metricKey);
  return {
    id: "",
    metricKey,
    sourceType: (def?.defaultSourceType ?? "NOT_CONNECTED") as SourceType,
    connectionId: null,
    mappingJson: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export interface MappingOverride {
  sourceType: SourceType;
  connectionId: string | null;
  mappingJson: Record<string, unknown> | null;
  active: boolean;
}

export async function computeMetric(
  metricKey: string,
  periodKey: string,
  target: ResolvedTerritory,
  override?: MappingOverride,
): Promise<KpiComputation> {
  const mapping = override ?? (await getEffectiveMapping(metricKey));

  if (!mapping.active) {
    return notConnected("This metric's mapping is currently disabled in Admin > Connections & data.");
  }

  switch (mapping.sourceType as SourceType) {
    case "PARTNER_RADAR":
      return computePartnerRadar(periodKey, target);
    case "ACTIVITIES":
      return computeActivities(metricKey, target);
    case "DEMO":
      return computeDemo(metricKey, periodKey, target);
    case "MANUAL":
      return computeManual(metricKey, periodKey, target);
    case "HUBSPOT": {
      if (!mapping.connectionId) return notConnected("HubSpot source selected, but no connection is linked yet.");
      const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.id, mapping.connectionId));
      if (!conn || !hasCredential(conn.credentialEnvVar)) {
        return notConnected(`HubSpot connection is not configured (missing ${conn?.credentialEnvVar ?? "credential"}).`);
      }
      if (!mapping.mappingJson) return notConnected("HubSpot connection is configured, but this metric still needs mapping.");
      // A real HubSpot connection + mapping exists, but the live-call
      // implementation (services/hubspot.ts) intentionally throws until a
      // real integration is built -- report NOT_CONNECTED honestly instead
      // of fabricating a value.
      return notConnected("HubSpot connection and mapping are configured, but the live sync is not implemented yet.");
    }
    case "NOT_CONNECTED":
    default:
      return notConnected("This metric has no data source configured yet.");
  }
}

export function reconcile(current: number | null, byTerritory: TerritoryContribution[]): { reconciles: boolean; note: string | null } {
  if (current === null || byTerritory.length === 0) return { reconciles: true, note: null };
  const sum = byTerritory.reduce((acc, t) => acc + t.value, 0);
  const tolerance = Math.max(1, Math.abs(current) * 0.01);
  if (Math.abs(sum - current) <= tolerance) return { reconciles: true, note: null };
  return {
    reconciles: false,
    note: `Data does not reconcile: territory total (${sum}) does not match reported total (${current}).`,
  };
}

export async function buildHeadOfChannelsData(periodKey: string, target: ResolvedTerritory) {
  const allMetrics = METRIC_REGISTRY;
  const devKeys = allMetrics.filter((m) => m.views.includes("partner_development"));
  const commercialKeys = allMetrics.filter((m) => m.views.includes("weekly_commercial"));
  const marketingKeys = allMetrics.filter((m) => m.views.includes("weekly_marketing"));

  const partnerDevelopment = await Promise.all(
    devKeys.map(async (def) => {
      const c = await computeMetric(def.key, periodKey, target);
      return {
        metric_key: def.key,
        metric: def.label,
        current: c.current ?? 0,
        target: c.target ?? 0,
        status: c.status ?? "amber",
        what_changed: c.what_changed,
        explanation: c.explanation,
        data_source: c.data_source,
        last_updated: c.last_updated,
        data_status: c.data_status,
      };
    }),
  );

  const weeklyCommercial = await Promise.all(
    commercialKeys.map(async (def) => {
      const c = await computeMetric(def.key, periodKey, target);
      return {
        metric_key: def.key,
        metric: def.label,
        current: c.current ?? 0,
        last_week: c.last_week ?? c.current ?? 0,
        target: c.target ?? 0,
        trend: c.trend ?? "flat",
        explanation: c.explanation,
        data_source: c.data_source,
        last_updated: c.last_updated,
        data_status: c.data_status,
      };
    }),
  );

  const weeklyMarketing = await Promise.all(
    marketingKeys.map(async (def) => {
      const c = await computeMetric(def.key, periodKey, target);
      return {
        metric_key: def.key,
        metric: def.label,
        this_week: c.current ?? 0,
        last_week: c.last_week,
        trend: c.trend ?? "flat",
        explanation: c.explanation,
        data_source: c.data_source,
        last_updated: c.last_updated,
        data_status: c.data_status,
      };
    }),
  );

  return { partnerDevelopment, weeklyCommercial, weeklyMarketing };
}

export { resolvePeriodKey, PERIODS };
