// Service boundary for the LLM that structures Channel Radar evidence into
// a qualified competitive/ecosystem signal. DeepSeek is the implemented
// provider, reusing the same AI_PROVIDER=deepseek / AI_API_KEY credential
// already configured for the Overview AI Channel Brief and Discovery
// qualification -- but this module's prompt, response schema, and
// hardening are entirely its own, deliberately not imported from either of
// those (Discovery answers "should we recruit this company"; Radar answers
// "what changed in the ecosystem and why does it matter" -- different
// business meaning, kept as separate modules on purpose).
//
// The LLM must only structure and judge the supplied evidence -- it must
// never invent a company fact, a geography, or a source URL it wasn't given.
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { connectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hasCredential } from "../connections";
import { logger } from "../../lib/logger";

export class RadarAiNotImplementedError extends Error {
  constructor() {
    super("AI structuring is not implemented yet. Configure a connection before relying on live Channel Radar.");
    this.name = "RadarAiNotImplementedError";
  }
}

export class RadarAiProviderError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "RadarAiProviderError";
  }
}

const ENTITY_TYPES = ["competitor", "partner", "ecosystem", "other"] as const;
const SIGNAL_TYPES = [
  "acquisition",
  "partnership",
  "reseller_distributor",
  "regional_expansion",
  "leadership_hire",
  "funding",
  "customer_win",
  "product_gtm",
  "marketplace_listing",
  "event",
  "other",
] as const;
const IMPLICATIONS = ["opportunity", "threat", "neutral"] as const;
const IMPACTS = ["high", "medium", "low"] as const;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export interface RadarEvidenceItem {
  url: string;
  title: string;
  text: string;
}

export interface RadarQualificationInput {
  // The entity this evidence was searched for -- the caller's own record of
  // which monitored entity produced this query, not something the model
  // needs to infer.
  entityHint: string;
  territoryName: string;
  evidence: RadarEvidenceItem[];
}

export interface RadarQualificationOutput {
  keep: boolean;
  entityName: string;
  entityType: (typeof ENTITY_TYPES)[number];
  signalType: (typeof SIGNAL_TYPES)[number];
  headline: string;
  summary: string;
  whyItMatters: string;
  implication: (typeof IMPLICATIONS)[number];
  impact: (typeof IMPACTS)[number];
  recommendedAction: string;
  confidence: (typeof CONFIDENCE_LEVELS)[number];
  evidenceUrls: string[];
}

const RadarQualificationSchema = z.object({
  keep: z.boolean(),
  entity_name: z.string().min(1).max(200),
  entity_type: z.enum(ENTITY_TYPES),
  signal_type: z.enum(SIGNAL_TYPES),
  headline: z.string().min(1).max(150),
  summary: z.string().min(1).max(600),
  why_it_matters: z.string().min(1).max(500),
  implication: z.enum(IMPLICATIONS),
  impact: z.enum(IMPACTS),
  recommended_action: z.string().min(1).max(400),
  confidence: z.enum(CONFIDENCE_LEVELS),
  evidence_urls: z.array(z.string()),
});

const MAX_TOKENS = 900;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 50_000;

const SYSTEM_PROMPT = `You are an intelligence analyst for a channel/alliances team at DRUID, an enterprise conversational/agentic AI platform vendor. You review web evidence about a named company (a competitor, an existing/prospective partner, or another ecosystem player) and decide whether it represents a meaningful signal for DRUID's Channels & Alliances team.

You will be given:
- entity_hint: the company this evidence was searched for.
- territory_name: the DRUID territory this scan is running for (context only -- never invent that a signal applies more broadly than the evidence supports).
- evidence: one or more {url, title, text} items -- your ONLY source of truth. Never invent a fact, event, date, geography, or company detail not present in this text.

Decide "keep": true only if this is a genuinely meaningful, specific signal relevant to a B2B channel/alliances team -- an acquisition, a real partnership/alliance, a reseller or distributor relationship, regional/market expansion, a channel or alliance leadership hire, a funding round, a named customer win, a real product or go-to-market move, a marketplace/ecosystem listing, or a real conference/webinar appearance. Reject (keep: false) generic market commentary, vague trend pieces, unrelated news, or anything too weak/general to act on.

Every kept signal must have a plausible, concrete channel/sales implication -- if you cannot articulate why a channel/alliances person would care, keep: false.

"implication" must be your honest read: "opportunity" if this could open a door for DRUID, "threat" if it strengthens a competitor or closes a door, "neutral" if it's relevant context with no clear directional read. Do not force everything into opportunity or threat -- neutral is a real, expected answer.

Write headline, summary, why_it_matters, and recommended_action in plain, natural channel/sales language -- like a sharp colleague briefing a teammate, not corporate or robotic prose. Avoid stock phrases like "a useful first conversation would explore..." -- be specific and concrete, grounded only in the evidence.

evidence_urls must be a subset of the URLs you were actually given -- never a URL you were not given.

Respond with ONLY a single JSON object, no markdown, no commentary, matching exactly this shape:
{
  "keep": boolean,
  "entity_name": "string -- the company's real name, from the evidence",
  "entity_type": "competitor | partner | ecosystem | other",
  "signal_type": "acquisition | partnership | reseller_distributor | regional_expansion | leadership_hire | funding | customer_win | product_gtm | marketplace_listing | event | other",
  "headline": "string, at most 150 characters",
  "summary": "string, at most 600 characters -- what happened",
  "why_it_matters": "string, at most 500 characters -- why DRUID Channels should care",
  "implication": "opportunity | threat | neutral",
  "impact": "high | medium | low",
  "recommended_action": "string, at most 400 characters -- a concrete next step",
  "confidence": "high | medium | low",
  "evidence_urls": ["url1", "..."]
}
If keep is false, still fill every field honestly (e.g. impact "low", confidence reflecting your actual certainty) -- the caller discards the record either way, but never leave a field empty or fabricated.`;

export async function isConfigured(): Promise<boolean> {
  const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.providerType, "ai"));
  return process.env.AI_PROVIDER === "deepseek" && hasCredential(conn?.credentialEnvVar ?? null);
}

export async function qualifySignal(input: RadarQualificationInput): Promise<RadarQualificationOutput> {
  if (!(await isConfigured())) throw new RadarAiNotImplementedError();

  switch (process.env.AI_PROVIDER) {
    case "deepseek":
      return qualifySignalViaDeepSeek(input);
    default:
      throw new RadarAiNotImplementedError();
  }
}

// Exported (not just called internally) so it can be unit-tested directly
// against a mocked fetch, without needing a live DB-backed isConfigured()
// check in the test.
export async function qualifySignalViaDeepSeek(input: RadarQualificationInput): Promise<RadarQualificationOutput> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new RadarAiNotImplementedError();

  const payload = {
    entity_hint: input.entityHint,
    territory_name: input.territoryName,
    evidence: input.evidence,
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
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    });
  } catch (err) {
    throw new RadarAiProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new RadarAiProviderError("http_error");

  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new RadarAiProviderError("oversized_response");
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RadarAiProviderError("malformed_json");
  }

  const choice = body?.choices?.[0];
  const rawContent = choice?.message?.content;
  if (!choice || typeof rawContent !== "string" || rawContent.trim() === "") {
    throw new RadarAiProviderError("empty_response");
  }
  if (choice.finish_reason === "length") {
    throw new RadarAiProviderError("truncated");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new RadarAiProviderError("malformed_json");
  }

  const validated = RadarQualificationSchema.safeParse(parsed);
  if (!validated.success) throw new RadarAiProviderError("schema_invalid");

  const validEvidenceUrls = new Set(input.evidence.map((e) => e.url));
  const filteredEvidenceUrls = validated.data.evidence_urls.filter((url) => validEvidenceUrls.has(url));
  if (filteredEvidenceUrls.length !== validated.data.evidence_urls.length) {
    logger.warn(
      { dropped: validated.data.evidence_urls.length - filteredEvidenceUrls.length },
      "Channel Radar qualification: filtered invalid evidence URL reference(s)",
    );
  }

  return {
    keep: validated.data.keep,
    entityName: validated.data.entity_name,
    entityType: validated.data.entity_type,
    signalType: validated.data.signal_type,
    headline: validated.data.headline,
    summary: validated.data.summary,
    whyItMatters: validated.data.why_it_matters,
    implication: validated.data.implication,
    impact: validated.data.impact,
    recommendedAction: validated.data.recommended_action,
    confidence: validated.data.confidence,
    evidenceUrls: filteredEvidenceUrls,
  };
}
