import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { metricMappingsTable, manualMetricValuesTable, connectionsTable, territoriesTable } from "@workspace/db";
import {
  ListMetricMappingsResponse,
  UpsertMetricMappingBody,
  UpsertMetricMappingResponse,
  PreviewMetricMappingBody,
  ListManualMetricValuesResponse,
  UpsertManualMetricValueBody,
  UpsertManualMetricValueResponse,
} from "@workspace/api-zod";
import { eq, and } from "drizzle-orm";
import { METRIC_BY_KEY } from "../services/kpiRegistry";
import { computeMetric, reconcile, resolvePeriodKey, resolveTerritory } from "../services/kpiService";
import { hasCredential } from "../services/connections";
import { requireAdmin } from "../middleware/auth";

const router: IRouter = Router();

async function mappingStatusFor(mapping: typeof metricMappingsTable.$inferSelect | undefined, defaultSourceType: string) {
  const sourceType = mapping?.sourceType ?? defaultSourceType;
  if (sourceType === "DEMO") return "demo" as const;
  if (sourceType === "NOT_CONNECTED") return "not_connected" as const;
  if (sourceType === "PARTNER_RADAR" || sourceType === "ACTIVITIES") return "connected" as const;
  if (sourceType === "MANUAL") {
    const rows = await db.select().from(manualMetricValuesTable).where(eq(manualMetricValuesTable.metricKey, mapping!.metricKey));
    return rows.length > 0 ? ("connected" as const) : ("needs_mapping" as const);
  }
  if (sourceType === "HUBSPOT") {
    if (!mapping?.connectionId || !mapping.mappingJson) return "needs_mapping" as const;
    const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.id, mapping.connectionId));
    return conn && hasCredential(conn.credentialEnvVar) ? ("connected" as const) : ("needs_mapping" as const);
  }
  return "not_connected" as const;
}

router.get("/metric-mappings", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(metricMappingsTable);
  const byKey = new Map(rows.map((r) => [r.metricKey, r]));
  const target = await resolveTerritory(null);

  const results = await Promise.all(
    Array.from(METRIC_BY_KEY.values()).map(async (def) => {
      const mapping = byKey.get(def.key);
      const status = await mappingStatusFor(mapping, def.defaultSourceType);
      const computed = await computeMetric(def.key, resolvePeriodKey(null), target);
      return {
        id: mapping?.id ?? "",
        metric_key: def.key,
        metric_label: def.label,
        source_type: mapping?.sourceType ?? def.defaultSourceType,
        connection_id: mapping?.connectionId ?? null,
        mapping_json: mapping?.mappingJson ?? null,
        active: mapping?.active ?? true,
        mapping_status: status,
        current_data_status: computed.data_status,
        updated_at: (mapping?.updatedAt ?? new Date()).toISOString(),
      };
    }),
  );

  res.json(ListMetricMappingsResponse.parse(results));
});

router.put("/metric-mappings/:metric_key", requireAdmin, async (req, res): Promise<void> => {
  const metricKey = Array.isArray(req.params.metric_key) ? req.params.metric_key[0] : req.params.metric_key;
  const def = METRIC_BY_KEY.get(metricKey);
  if (!def) {
    res.status(404).json({ error: `Unknown metric_key: ${metricKey}` });
    return;
  }
  const body = UpsertMetricMappingBody.parse(req.body);

  const [existing] = await db.select().from(metricMappingsTable).where(eq(metricMappingsTable.metricKey, metricKey));
  const now = new Date();
  let saved: typeof metricMappingsTable.$inferSelect;
  if (existing) {
    [saved] = await db
      .update(metricMappingsTable)
      .set({
        sourceType: body.source_type,
        connectionId: body.connection_id ?? null,
        mappingJson: body.mapping_json ?? null,
        active: body.active ?? existing.active,
        updatedAt: now,
      })
      .where(eq(metricMappingsTable.metricKey, metricKey))
      .returning();
  } else {
    [saved] = await db
      .insert(metricMappingsTable)
      .values({
        metricKey,
        sourceType: body.source_type,
        connectionId: body.connection_id ?? null,
        mappingJson: body.mapping_json ?? null,
        active: body.active ?? true,
      })
      .returning();
  }

  const status = await mappingStatusFor(saved, def.defaultSourceType);
  const target = await resolveTerritory(null);
  const computed = await computeMetric(metricKey, resolvePeriodKey(null), target);

  res.json(UpsertMetricMappingResponse.parse({
    id: saved.id,
    metric_key: metricKey,
    metric_label: def.label,
    source_type: saved.sourceType,
    connection_id: saved.connectionId,
    mapping_json: saved.mappingJson,
    active: saved.active,
    mapping_status: status,
    current_data_status: computed.data_status,
    updated_at: saved.updatedAt.toISOString(),
  }));
});

router.post("/metric-mappings/:metric_key/preview", requireAdmin, async (req, res): Promise<void> => {
  const metricKey = Array.isArray(req.params.metric_key) ? req.params.metric_key[0] : req.params.metric_key;
  const def = METRIC_BY_KEY.get(metricKey);
  if (!def) {
    res.status(404).json({ error: `Unknown metric_key: ${metricKey}` });
    return;
  }
  const body = PreviewMetricMappingBody.parse(req.body);
  const periodKey = resolvePeriodKey(body.period);
  const target = await resolveTerritory(body.territory);

  const computed = !( body.active ?? true)
    ? { current: null, target: null, last_week: null, trend: null, status: null, data_status: "NOT_CONNECTED" as const, data_source: null, last_updated: null, what_changed: null, explanation: "This mapping would be inactive.", by_territory: [], records: [] }
    : await computeMetric(metricKey, periodKey, target, {
        sourceType: body.source_type,
        connectionId: body.connection_id ?? null,
        mappingJson: body.mapping_json ?? null,
        active: true,
      });

  const { reconciles, note } = reconcile(computed.current, computed.by_territory);
  res.json({
    metric_key: metricKey,
    metric: def.label,
    period: resolvePeriodKey(body.period),
    territory: target.territoryName,
    current: computed.current,
    target: computed.target,
    last_week: computed.last_week,
    trend: computed.trend,
    status: computed.status,
    data_status: computed.data_status,
    data_source: computed.data_source,
    last_updated: computed.last_updated,
    what_changed: computed.what_changed,
    explanation: computed.explanation,
    by_territory: computed.by_territory,
    records: computed.records,
    reconciles,
    reconciliation_note: note,
  });
});

router.get("/manual-metric-values", requireAdmin, async (req, res): Promise<void> => {
  const { metric_key } = req.query as { metric_key?: string };
  const rows = metric_key
    ? await db.select().from(manualMetricValuesTable).where(eq(manualMetricValuesTable.metricKey, metric_key))
    : await db.select().from(manualMetricValuesTable);
  const territories = await db.select().from(territoriesTable);
  const territoryName = (id: string | null) => (id ? territories.find((t) => t.id === id)?.name ?? "Unknown" : "Global");

  res.json(ListManualMetricValuesResponse.parse(rows.map((r) => ({
    id: r.id,
    metric_key: r.metricKey,
    period: r.period,
    territory_id: r.territoryId,
    territory_name: territoryName(r.territoryId),
    current_value: Number(r.currentValue),
    target_value: r.targetValue !== null ? Number(r.targetValue) : null,
    note: r.note,
    updated_at: r.updatedAt.toISOString(),
  }))));
});

router.put("/manual-metric-values", requireAdmin, async (req, res): Promise<void> => {
  const body = UpsertManualMetricValueBody.parse(req.body);
  if (!METRIC_BY_KEY.has(body.metric_key)) {
    res.status(404).json({ error: `Unknown metric_key: ${body.metric_key}` });
    return;
  }

  const whereMatch = body.territory_id
    ? and(eq(manualMetricValuesTable.metricKey, body.metric_key), eq(manualMetricValuesTable.period, body.period), eq(manualMetricValuesTable.territoryId, body.territory_id))
    : and(eq(manualMetricValuesTable.metricKey, body.metric_key), eq(manualMetricValuesTable.period, body.period));

  const existingRows = await db.select().from(manualMetricValuesTable).where(whereMatch);
  const existing = existingRows.find((r) => (body.territory_id ? r.territoryId === body.territory_id : r.territoryId === null));

  const now = new Date();
  let saved: typeof manualMetricValuesTable.$inferSelect;
  if (existing) {
    [saved] = await db
      .update(manualMetricValuesTable)
      .set({
        currentValue: String(body.current_value),
        targetValue: body.target_value !== undefined && body.target_value !== null ? String(body.target_value) : null,
        note: body.note ?? null,
        updatedAt: now,
      })
      .where(eq(manualMetricValuesTable.id, existing.id))
      .returning();
  } else {
    [saved] = await db
      .insert(manualMetricValuesTable)
      .values({
        metricKey: body.metric_key,
        period: body.period,
        territoryId: body.territory_id ?? null,
        currentValue: String(body.current_value),
        targetValue: body.target_value !== undefined && body.target_value !== null ? String(body.target_value) : null,
        note: body.note ?? null,
      })
      .returning();
  }

  const territories = await db.select().from(territoriesTable);
  const territoryName = saved.territoryId ? territories.find((t) => t.id === saved.territoryId)?.name ?? "Unknown" : "Global";

  res.json(UpsertManualMetricValueResponse.parse({
    id: saved.id,
    metric_key: saved.metricKey,
    period: saved.period,
    territory_id: saved.territoryId,
    territory_name: territoryName,
    current_value: Number(saved.currentValue),
    target_value: saved.targetValue !== null ? Number(saved.targetValue) : null,
    note: saved.note,
    updated_at: saved.updatedAt.toISOString(),
  }));
});

export default router;
