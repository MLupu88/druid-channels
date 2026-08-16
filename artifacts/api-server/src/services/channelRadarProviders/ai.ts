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
import { resolveProviderSecret, hasResolvableCredential } from "../connections";
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

const ENTITY_TYPES = ["competitor", "partner", "ecosystem", "technology_vendor", "other"] as const;
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
  "partner_program",
  "tender_rfp",
  "other",
] as const;
const IMPLICATIONS = ["opportunity", "threat", "watch", "neutral"] as const;
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
  // Phase 10: the DRUID capability/partner motion this connects to, kept
  // separate from recommendedAction (a specific next step). Null when
  // nothing specific is justified by the evidence -- never forced.
  druidPartnerMotion: string | null;
  confidence: (typeof CONFIDENCE_LEVELS)[number];
  evidenceUrls: string[];
  // Phase 10: the event's counterparty, when it has one (e.g. who a
  // competitor partnered with/acquired/invested in). All three null
  // together when the evidence names no second company -- never invented.
  relatedEntityName: string | null;
  relatedEntityType: (typeof ENTITY_TYPES)[number] | null;
  relationshipLabel: string | null;
  // Phase 10: true only if the evidence TEXT ITSELF grounds this event in
  // the given territory -- not merely because the search was geo-scoped.
  // One input to requiresValidation (channelRadarEngine.ts), never
  // conflated with confidence.
  regionalApplicabilityCertain: boolean;
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
  druid_partner_motion: z.string().max(300).nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  evidence_urls: z.array(z.string()),
  related_entity_name: z.string().max(200).nullable(),
  related_entity_type: z.enum(ENTITY_TYPES).nullable(),
  relationship_label: z.string().max(150).nullable(),
  regional_applicability_certain: z.boolean(),
});

const MAX_TOKENS = 1100;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 50_000;

const SYSTEM_PROMPT = `You are an intelligence analyst for a channel/alliances team at DRUID, an enterprise conversational/agentic AI platform vendor. You review web evidence about a named company (a competitor, an existing/prospective partner, or another ecosystem player) and decide whether it represents a meaningful signal for DRUID's Channels & Alliances team.

You will be given:
- entity_hint: the company this evidence was searched for.
- territory_name: the DRUID territory this scan is running for (context only -- never invent that a signal applies more broadly than the evidence supports).
- evidence: one or more {url, title, text} items -- your ONLY source of truth. Never invent a fact, event, date, geography, or company detail not present in this text.

Decide "keep": true only if this is a genuinely meaningful, specific signal relevant to a B2B channel/alliances team -- an acquisition, a real partnership/alliance, a reseller or distributor relationship, regional/market expansion, a channel or alliance leadership hire, a funding round, a named customer win, a real product or go-to-market move, a marketplace/ecosystem listing, a published partner program, a tender/RFP award, or a real conference/webinar appearance. Reject (keep: false) generic market commentary, vague trend pieces, unrelated news, or anything too weak/general to act on.

Every kept signal must have a plausible, concrete channel/sales implication -- if you cannot articulate why a channel/alliances person would care, keep: false.

"implication" must be your honest read: "opportunity" if this could open a door for DRUID, "threat" if it strengthens a competitor or closes a door, "watch" if it's strategically relevant and worth tracking but there isn't yet enough evidence or urgency to call it an opportunity or a threat, "neutral" if it's relevant context with no directional read at all. Do not force everything into opportunity or threat -- watch and neutral are both real, expected answers. Keep this independent of "confidence": confidence is about how sure you are the evidence is accurate and complete; implication is about the direction, if any. A "watch" item can be high-confidence (you're very sure this vague-but-relevant thing happened) or low-confidence.

"entity_type" includes "technology_vendor" for a company whose relevance here is specifically as a technology/platform partner-of-partners (distinct from "ecosystem" for a broader, less specific ecosystem player).

Write headline, summary, why_it_matters, and recommended_action in plain, natural channel/sales language -- like a sharp colleague briefing a teammate, not corporate or robotic prose. Avoid stock phrases like "a useful first conversation would explore..." -- be specific and concrete, grounded only in the evidence.

"druid_partner_motion" names the specific DRUID capability or partner motion this connects to (e.g. "contact-center integrators", "AI-agent platform partners") ONLY when the evidence genuinely justifies one -- null otherwise. Keep it distinct from recommended_action (a next step, not a capability label).

"related_entity_name"/"related_entity_type"/"relationship_label": if the evidence names a SECOND company this event is specifically about (e.g. who a competitor partnered with, acquired, or invested in), capture it here, with relationship_label a short evidence-grounded descriptor (e.g. "reseller", "acquirer of", "technology alliance with"). Leave all three null together when there is no second named company -- never invent one just to fill the field.

"regional_applicability_certain": true only if the evidence TEXT ITSELF grounds this event in territory_name (or one of its countries) -- false if the evidence doesn't make the regional connection explicit, even if you otherwise trust the event happened. Never assume regional relevance just because that's what was searched for.

evidence_urls must be a subset of the URLs you were actually given -- never a URL you were not given.

Respond with ONLY a single JSON object, no markdown, no commentary, matching exactly this shape:
{
  "keep": boolean,
  "entity_name": "string -- the company's real name, from the evidence",
  "entity_type": "competitor | partner | ecosystem | technology_vendor | other",
  "signal_type": "acquisition | partnership | reseller_distributor | regional_expansion | leadership_hire | funding | customer_win | product_gtm | marketplace_listing | event | partner_program | tender_rfp | other",
  "headline": "string, at most 150 characters",
  "summary": "string, at most 600 characters -- what happened",
  "why_it_matters": "string, at most 500 characters -- why DRUID Channels should care",
  "implication": "opportunity | threat | watch | neutral",
  "impact": "high | medium | low",
  "recommended_action": "string, at most 400 characters -- a concrete next step",
  "druid_partner_motion": "string, at most 300 characters, or null",
  "confidence": "high | medium | low",
  "evidence_urls": ["url1", "..."],
  "related_entity_name": "string, at most 200 characters, or null",
  "related_entity_type": "competitor | partner | ecosystem | technology_vendor | other, or null",
  "relationship_label": "string, at most 150 characters, or null",
  "regional_applicability_certain": boolean
}
If keep is false, still fill every field honestly (e.g. impact "low", confidence reflecting your actual certainty) -- the caller discards the record either way, but never leave a field empty or fabricated.`;

export async function isConfigured(): Promise<boolean> {
  return process.env.AI_PROVIDER === "deepseek" && (await hasResolvableCredential("ai"));
}

export async function qualifySignal(input: RadarQualificationInput): Promise<RadarQualificationOutput> {
  if (!(await isConfigured())) throw new RadarAiNotImplementedError();

  switch (process.env.AI_PROVIDER) {
    case "deepseek": {
      const apiKey = await resolveProviderSecret("ai");
      if (!apiKey) throw new RadarAiNotImplementedError();
      return qualifySignalViaDeepSeek(apiKey, input);
    }
    default:
      throw new RadarAiNotImplementedError();
  }
}

// Exported (not just called internally) so it can be unit-tested directly
// against a mocked fetch, without needing a live DB-backed isConfigured()
// check in the test. apiKey is now an explicit parameter (the caller
// resolves it via resolveProviderSecret) rather than read from process.env
// internally.
export async function qualifySignalViaDeepSeek(apiKey: string, input: RadarQualificationInput): Promise<RadarQualificationOutput> {
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
    druidPartnerMotion: validated.data.druid_partner_motion,
    confidence: validated.data.confidence,
    evidenceUrls: filteredEvidenceUrls,
    relatedEntityName: validated.data.related_entity_name,
    relatedEntityType: validated.data.related_entity_type,
    relationshipLabel: validated.data.relationship_label,
    regionalApplicabilityCertain: validated.data.regional_applicability_certain,
  };
}

// ---- Cross-run same-event classification (Phase 10) -----------------------
//
// Narrow, bounded binary decision: given exactly one existing signal
// (already-persisted, possibly human-reviewed) and exactly one new piece of
// evidence -- both already deterministically pre-filtered to be plausible
// candidates by channelRadarEngine.ts's candidate search (same territory,
// same entity, same signal_type, within the match window) -- decide whether
// the new evidence describes the SAME underlying real-world event or a
// DIFFERENT one. This is never an open-ended similarity search: the model
// sees only the one candidate it's asked about, grounded in text it's
// actually given, and is never asked to browse or recall anything else.
// Deliberately a separate, smaller prompt from qualifySignal above -- a
// different, much narrower question ("is this the same event as THIS one
// specific existing signal" vs. "structure this evidence into a new
// signal").

export interface SameEventCandidate {
  headline: string;
  summary: string;
  sourceTitle: string;
  sourceUrl: string;
}

export interface SameEventEvidence {
  url: string;
  title: string;
  text: string;
}

export interface SameEventInput {
  entityHint: string;
  candidate: SameEventCandidate;
  newEvidence: SameEventEvidence;
}

export interface SameEventOutput {
  sameEvent: boolean;
}

const SameEventSchema = z.object({ same_event: z.boolean() });

const SAME_EVENT_MAX_TOKENS = 60;
const SAME_EVENT_SYSTEM_PROMPT = `You are checking whether two pieces of web evidence about the same company describe the SAME underlying real-world event (e.g. the same acquisition, the same partnership announcement, the same hire) or two DIFFERENT events.

You will be given:
- entity_hint: the company both pieces of evidence concern.
- existing_signal: {headline, summary, source_title, source_url} -- an event already on record.
- new_evidence: {url, title, text} -- a newly found piece of evidence about the same company and the same general category of event.

Answer same_event: true ONLY if you are reasonably confident these describe the exact same event (same transaction, same announcement, same hire, etc.), even if reported by a different outlet with different wording or a different publish date. If there is any real doubt -- different counterparties, different dates suggesting two separate happenings, or simply not enough overlap to be sure -- answer false. When uncertain, always answer false: a missed consolidation is far cheaper than wrongly merging two different events into one.

Respond with ONLY a single JSON object, no markdown, no commentary: { "same_event": boolean }`;

export async function classifySameEvent(input: SameEventInput): Promise<SameEventOutput> {
  if (!(await isConfigured())) throw new RadarAiNotImplementedError();

  switch (process.env.AI_PROVIDER) {
    case "deepseek": {
      const apiKey = await resolveProviderSecret("ai");
      if (!apiKey) throw new RadarAiNotImplementedError();
      return classifySameEventViaDeepSeek(apiKey, input);
    }
    default:
      throw new RadarAiNotImplementedError();
  }
}

// Exported for direct unit testing against a mocked fetch, same convention
// as qualifySignalViaDeepSeek above. apiKey is an explicit parameter, same
// reasoning as qualifySignalViaDeepSeek.
export async function classifySameEventViaDeepSeek(apiKey: string, input: SameEventInput): Promise<SameEventOutput> {
  const payload = {
    entity_hint: input.entityHint,
    existing_signal: {
      headline: input.candidate.headline,
      summary: input.candidate.summary,
      source_title: input.candidate.sourceTitle,
      source_url: input.candidate.sourceUrl,
    },
    new_evidence: input.newEvidence,
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
        max_tokens: SAME_EVENT_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: SAME_EVENT_SYSTEM_PROMPT },
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

  const validated = SameEventSchema.safeParse(parsed);
  if (!validated.success) throw new RadarAiProviderError("schema_invalid");

  return { sameEvent: validated.data.same_event };
}
