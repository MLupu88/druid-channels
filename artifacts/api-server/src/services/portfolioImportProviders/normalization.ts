// Service boundary for the LLM that semantically normalizes one PAM
// Portfolio import batch's rows into a strict proposal shape. Reuses the
// same AI_PROVIDER=deepseek / AI_API_KEY credential and hardening
// convention as channelRadarProviders/ai.ts and aiBriefProvider.ts (20s
// timeout, size cap, no retries, strict zod validation) -- but this
// module's prompt/schema is entirely its own: Radar answers "what changed
// in the ecosystem," this answers "what did the PAM's book actually say
// about this row."
//
// Deterministic code (see portfolioImportEngine.ts) already extracts
// whatever a spreadsheet's own column headers make obvious -- this module
// is only for what's genuinely ambiguous: free-text descriptions, unclear
// headings, partner-type/status interpretation. It must never invent a
// fact not present in the row, and it does NOT classify date precision
// itself (that's a deterministic pattern-matching step, see
// companyMatchingService.classifyDatePhrase) -- it only extracts the raw
// date phrase verbatim.
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { connectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hasCredential } from "../connections";
import { logger } from "../../lib/logger";

export class NormalizationNotImplementedError extends Error {
  constructor() {
    super("AI normalization is not implemented yet. Configure a connection before importing a Portfolio book.");
    this.name = "NormalizationNotImplementedError";
  }
}

export class NormalizationProviderError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "NormalizationProviderError";
  }
}

// Bounded batch size -- never one DeepSeek call per row. Mirrors the
// cost-controlled convention established by Discovery/Radar's bounded
// query building.
export const MAX_ROWS_PER_NORMALIZATION_CALL = 15;

const STATUS_HINTS = ["active", "dormant", "unknown"] as const;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export interface NormalizationRowInput {
  rowIndex: number;
  sourceRaw: Record<string, string>;
  // Whatever deterministic column/header mapping already resolved -- given
  // to DeepSeek as known-good context, not something it needs to re-derive.
  deterministicHints: {
    companyName: string | null;
    domain: string | null;
    country: string | null;
    partnerType: string | null;
  };
}

export interface NormalizationRowOutput {
  rowIndex: number;
  companyName: string | null;
  domain: string | null;
  country: string | null;
  partnerType: string | null;
  relationshipSummary: string | null;
  statusHint: (typeof STATUS_HINTS)[number];
  relationshipStartedAtRawText: string | null;
  nextAction: string | null;
  confidence: (typeof CONFIDENCE_LEVELS)[number];
  needsReview: boolean;
  reasons: string[];
}

const RowResultSchema = z.object({
  row_index: z.number(),
  company_name: z.string().nullable(),
  domain: z.string().nullable(),
  country: z.string().nullable(),
  partner_type: z.string().nullable(),
  relationship_summary: z.string().max(800).nullable(),
  status_hint: z.enum(STATUS_HINTS),
  relationship_started_at_raw_text: z.string().max(60).nullable(),
  next_action: z.string().max(300).nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  needs_review: z.boolean(),
  reasons: z.array(z.string().max(60)).max(5),
});

const NormalizationResponseSchema = z.object({
  rows: z.array(RowResultSchema),
});

const MAX_TOKENS = 3500;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 150_000;

const SYSTEM_PROMPT = `You are a data-normalization assistant for a channel/alliances team at DRUID, an enterprise conversational/agentic AI platform vendor. A Partner Account Manager (PAM) has pasted or uploaded rows from their own partner book (a spreadsheet export or a free-text description), in an unpredictable format. Your job is to normalize each row into a strict structured shape.

You will be given a JSON array "rows", each with:
- row_index: echo this back unchanged.
- source_raw: the original row's column-name -> value map (or a single "text" field for a pasted free-text description).
- deterministic_hints: fields already confidently extracted by non-AI code (company_name, domain, country, partner_type) -- reuse these as-is when present rather than re-guessing; only fill in fields the deterministic pass left null.

For each row, output:
- company_name: the partner company's real name. Required -- if you genuinely cannot identify one, set it to null (never invent a placeholder name).
- domain: ONLY if a domain or website is literally present somewhere in the row's text. NEVER invent, guess, or recall a domain from general knowledge of the company -- if none is written down, this must be null.
- country: only if stated or unambiguously implied by the row's own text (e.g. a city name that is only in one country). Never guess a company's headquarters from general knowledge.
- partner_type: your best interpretation of what kind of partner this is (e.g. reseller, systems integrator, technology partner, distributor) if the text supports it, else null.
- relationship_summary: a short, natural-language distillation of any free-text context/comments in the row (contacts mentioned, technology focus, opportunities, general context) -- at most 800 characters. Null if the row has no such context.
- status_hint: "active" if the text suggests an ongoing/current relationship, "dormant" if it suggests inactivity/staleness, "unknown" if the text gives no signal either way.
- relationship_started_at_raw_text: the LITERAL phrase from the row describing when the relationship started, if any is present (e.g. "Q1 2026", "since 2024", "March 2023") -- copy it verbatim, do not convert it to an ISO date and do not classify its precision yourself. Null if no such phrase exists.
- next_action: a concrete next step if the row's text states or clearly implies one, else null.
- confidence: your honest confidence in this row's overall normalization ("high"/"medium"/"low").
- needs_review: true if company_name is null, if the row is ambiguous, or if confidence is not high.
- reasons: short codes explaining why needs_review is true (e.g. "no_company_name", "ambiguous_status", "sparse_context"). Empty array if needs_review is false.

Never invent information not present in the row. Unknown must stay null -- do not guess to fill a field.

Respond with ONLY a single JSON object, no markdown, no commentary, matching exactly:
{ "rows": [ { "row_index": number, "company_name": string|null, "domain": string|null, "country": string|null, "partner_type": string|null, "relationship_summary": string|null, "status_hint": "active"|"dormant"|"unknown", "relationship_started_at_raw_text": string|null, "next_action": string|null, "confidence": "high"|"medium"|"low", "needs_review": boolean, "reasons": string[] } ] }
The "rows" array must contain exactly one result per input row, in the same order, with matching row_index values.`;

export async function isConfigured(): Promise<boolean> {
  const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.providerType, "ai"));
  return process.env.AI_PROVIDER === "deepseek" && hasCredential(conn?.credentialEnvVar ?? null);
}

export async function normalizeRows(rows: NormalizationRowInput[]): Promise<NormalizationRowOutput[]> {
  if (!(await isConfigured())) throw new NormalizationNotImplementedError();

  switch (process.env.AI_PROVIDER) {
    case "deepseek":
      return normalizeRowsViaDeepSeek(rows);
    default:
      throw new NormalizationNotImplementedError();
  }
}

// Exported (not just called internally) so it can be unit-tested directly
// against a mocked fetch, without needing a live DB-backed isConfigured()
// check in the test. Never called with more than
// MAX_ROWS_PER_NORMALIZATION_CALL rows -- the caller (portfolioImportEngine)
// is responsible for chunking.
export async function normalizeRowsViaDeepSeek(rows: NormalizationRowInput[]): Promise<NormalizationRowOutput[]> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new NormalizationNotImplementedError();
  if (rows.length === 0) return [];

  const payload = {
    rows: rows.map((r) => ({
      row_index: r.rowIndex,
      source_raw: r.sourceRaw,
      deterministic_hints: {
        company_name: r.deterministicHints.companyName,
        domain: r.deterministicHints.domain,
        country: r.deterministicHints.country,
        partner_type: r.deterministicHints.partnerType,
      },
    })),
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
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    });
  } catch (err) {
    throw new NormalizationProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new NormalizationProviderError("http_error");

  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new NormalizationProviderError("oversized_response");
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new NormalizationProviderError("malformed_json");
  }

  const choice = body?.choices?.[0];
  const rawContent = choice?.message?.content;
  if (!choice || typeof rawContent !== "string" || rawContent.trim() === "") {
    throw new NormalizationProviderError("empty_response");
  }
  if (choice.finish_reason === "length") {
    throw new NormalizationProviderError("truncated");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new NormalizationProviderError("malformed_json");
  }

  const validated = NormalizationResponseSchema.safeParse(parsed);
  if (!validated.success) throw new NormalizationProviderError("schema_invalid");

  const validRowIndexes = new Set(rows.map((r) => r.rowIndex));
  const results = validated.data.rows.filter((r) => validRowIndexes.has(r.row_index));
  if (results.length !== rows.length) {
    logger.warn(
      { expected: rows.length, received: validated.data.rows.length, matched: results.length },
      "Portfolio import normalization: response row count mismatch",
    );
  }

  return results.map((r) => ({
    rowIndex: r.row_index,
    companyName: r.company_name,
    domain: r.domain,
    country: r.country,
    partnerType: r.partner_type,
    relationshipSummary: r.relationship_summary,
    statusHint: r.status_hint,
    relationshipStartedAtRawText: r.relationship_started_at_raw_text,
    nextAction: r.next_action,
    confidence: r.confidence,
    needsReview: r.needs_review,
    reasons: r.reasons,
  }));
}
