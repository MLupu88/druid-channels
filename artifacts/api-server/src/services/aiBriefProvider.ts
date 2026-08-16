import { z } from "zod/v4";
import type { AiBriefEvidenceItem, AiChannelBriefContent } from "@workspace/db";
import { resolveProviderSecret, hasResolvableCredential } from "./connections";
import { logger } from "../lib/logger";

// Service boundary for generating the Overview AI Channel Brief. Deliberately
// separate from discoveryProviders/ai.ts (discovery qualification has its
// own shape/concerns) -- this module owns nothing about eligibility, caching,
// or snapshot-building (see aiChannelBriefService.ts for that); it only
// knows how to safely turn an already-prepared, already-eligible-filtered
// snapshot into validated content, or fail honestly.
//
// generate() is the single swap point for a future n8n-backed implementation:
// a later version can add a branch that POSTs to an n8n webhook instead of
// calling DeepSeek directly, with zero changes to the route or frontend
// contract, as long as it still returns AiChannelBriefContent or throws one
// of the errors below.

export class AiBriefNotConfiguredError extends Error {
  constructor() {
    super("AI provider is not connected.");
    this.name = "AiBriefNotConfiguredError";
  }
}

// code is a small closed set of internal failure classifications -- never
// the raw provider error text. See classifyAiBriefError() in
// aiChannelBriefService.ts for the user-facing mapping.
export class AiBriefProviderError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "AiBriefProviderError";
  }
}

export interface AiBriefMetricSnapshot {
  section: "channel_kpi" | "pipeline_revenue" | "channel_activity";
  metric_key: string;
  metric: string;
  current: number | null;
  target: number | null;
  status: string | null;
  trend: string | null;
  data_status: string;
  data_source: string | null;
  last_updated: string | null;
}

// The caller (aiChannelBriefService) is responsible for passing ONLY
// evidence-eligible (CONNECTED/MANUAL) metrics here -- this module has no
// concept of eligibility itself, it only ever sees what it's given.
export interface ChannelBriefSnapshot {
  period: string; // human-readable label (e.g. "Q3 2026") -- server-owned mapping done by the route, same convention as kpis.ts
  territoryId: string | null; // internal only -- read by the caller for hashing/scope, NEVER serialized into the provider payload below
  territoryName: string;
  currency: string;
  dataAsOf: string | null;
  metrics: AiBriefMetricSnapshot[];
}

export type { AiBriefEvidenceItem, AiChannelBriefContent };

const AiBriefEvidenceItemSchema = z.object({
  text: z.string().min(1).max(240),
  supporting_metrics: z.array(z.string()),
});

const AiChannelBriefContentSchema = z.object({
  executive_summary: z.string().min(1).max(800),
  key_highlights: z.array(AiBriefEvidenceItemSchema).max(6),
  risks: z.array(AiBriefEvidenceItemSchema).max(6),
  opportunities: z.array(AiBriefEvidenceItemSchema).max(6),
  recommended_actions: z.array(AiBriefEvidenceItemSchema).max(6),
});

const MAX_TOKENS = 900;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 50_000;

const SYSTEM_PROMPT = `You are an assistant that writes a compact executive brief for a B2B channel/partnerships leader, from a supplied JSON snapshot of KPI metrics.

Rules:
- You may only draw conclusions from the metrics supplied in the user message. Every metric supplied is already verified/eligible evidence -- there is nothing else to consider.
- Never invent a cause, competitor, event, or context not present in the supplied metrics.
- Every item in key_highlights, risks, opportunities, and recommended_actions must reference at least one real "metric_key" from the supplied metrics in its "supporting_metrics" array. Never reference a metric_key that was not supplied.
- If the supplied metrics do not support a risk, opportunity, or highlight, return an empty array for that field. Do not invent one to fill space.
- Do not generate timestamps, dates, period labels, or territory names -- use only the values already in the supplied data for context, and never state a freshness/recency claim not backed by the data.
- Respond with ONLY a single JSON object, no markdown, no commentary, matching exactly this shape:

{
  "executive_summary": "string, at most 800 characters",
  "key_highlights": [{ "text": "string, at most 240 characters", "supporting_metrics": ["metric_key", "..."] }],
  "risks": [{ "text": "string", "supporting_metrics": ["metric_key"] }],
  "opportunities": [{ "text": "string", "supporting_metrics": ["metric_key"] }],
  "recommended_actions": [{ "text": "string", "supporting_metrics": ["metric_key"] }]
}

Empty arrays are valid and expected when the data doesn't support that section.`;

export async function isConfigured(): Promise<boolean> {
  return process.env.AI_PROVIDER === "deepseek" && (await hasResolvableCredential("ai"));
}

export async function generate(snapshot: ChannelBriefSnapshot): Promise<AiChannelBriefContent> {
  if (!(await isConfigured())) throw new AiBriefNotConfiguredError();

  switch (process.env.AI_PROVIDER) {
    case "deepseek": {
      const apiKey = await resolveProviderSecret("ai");
      if (!apiKey) throw new AiBriefNotConfiguredError();
      return generateViaDeepSeek(apiKey, snapshot);
    }
    default:
      throw new AiBriefNotConfiguredError();
  }
}

async function generateViaDeepSeek(apiKey: string, snapshot: ChannelBriefSnapshot): Promise<AiChannelBriefContent> {
  // Built explicitly field-by-field -- snapshot.territoryId is never
  // referenced here, so it can't leak into the provider payload by accident.
  const payload = {
    period: snapshot.period,
    territory_name: snapshot.territoryName,
    currency: snapshot.currency,
    data_as_of: snapshot.dataAsOf,
    metrics: snapshot.metrics,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    });
  } catch (err) {
    throw new AiBriefProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new AiBriefProviderError("http_error");

  // Read as text first and enforce a size ceiling before ever parsing --
  // simplest safe option that doesn't require a streaming abstraction. The
  // raw text is never logged, on any path below.
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new AiBriefProviderError("oversized_response");
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AiBriefProviderError("malformed_json");
  }

  const choice = body?.choices?.[0];
  const rawContent = choice?.message?.content;
  if (!choice || typeof rawContent !== "string" || rawContent.trim() === "") {
    throw new AiBriefProviderError("empty_response");
  }
  if (choice.finish_reason === "length") {
    // A truncated response is not a usable brief, even if what's there so
    // far happens to parse as valid JSON.
    throw new AiBriefProviderError("truncated");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new AiBriefProviderError("malformed_json");
  }

  const validated = AiChannelBriefContentSchema.safeParse(parsed);
  if (!validated.success) throw new AiBriefProviderError("schema_invalid");

  return sanitizeSupportingMetrics(validated.data, snapshot.metrics.map((m) => m.metric_key));
}

// Filters each evidence item's supporting_metrics down to metric_keys that
// were actually supplied; an item left with zero valid references after
// filtering is dropped entirely rather than kept with an empty/misleading
// evidence list. Only bounded counts are logged -- never the narrative text.
function sanitizeSupportingMetrics(content: AiChannelBriefContent, validKeys: string[]): AiChannelBriefContent {
  const validSet = new Set(validKeys);
  let droppedInvalidRefs = 0;
  let droppedItems = 0;

  const clean = (items: AiBriefEvidenceItem[]): AiBriefEvidenceItem[] =>
    items
      .map((item) => {
        const filtered = item.supporting_metrics.filter((k) => validSet.has(k));
        if (filtered.length !== item.supporting_metrics.length) droppedInvalidRefs++;
        return { ...item, supporting_metrics: filtered };
      })
      .filter((item) => {
        const keep = item.supporting_metrics.length > 0;
        if (!keep) droppedItems++;
        return keep;
      });

  const result: AiChannelBriefContent = {
    executive_summary: content.executive_summary,
    key_highlights: clean(content.key_highlights),
    risks: clean(content.risks),
    opportunities: clean(content.opportunities),
    recommended_actions: clean(content.recommended_actions),
  };

  if (droppedInvalidRefs > 0 || droppedItems > 0) {
    logger.warn({ droppedInvalidRefs, droppedItems }, "AI channel brief: filtered invalid metric references");
  }

  return result;
}
