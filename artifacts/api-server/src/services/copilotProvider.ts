// Service boundary for the PAM Workspace Copilot's DeepSeek call. Reuses the
// exact AI_PROVIDER=deepseek / AI_API_KEY credential and connection already
// configured for the Overview AI Channel Brief and Discovery qualification
// (see aiBriefProvider.ts / discoveryProviders/ai.ts) -- but keeps its own
// prompt, response schema, and isConfigured() check independently
// maintainable, mirroring the exact convention those two modules already
// established (each provider boundary owns its own check rather than
// cross-importing one another).
//
// This module never touches the database beyond the isConfigured() check --
// the actual workspace/app-guide data it's given is already fully assembled
// by copilotContextService.ts and routes/pam_copilot.ts before it gets here.
// The model is never given SQL access, a company list beyond what it was
// handed, or any way to invent data outside the supplied JSON.
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { connectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hasCredential } from "./connections";
import type { AppGuideEntry } from "./appGuide";
import type { PamWorkspaceSummary, PartnerContext } from "./copilotContextService";

export class CopilotNotConfiguredError extends Error {
  constructor() {
    super("The Copilot's AI provider is not connected.");
    this.name = "CopilotNotConfiguredError";
  }
}

// A small closed set of internal failure classifications -- never the raw
// provider error text. See classifyCopilotError() in routes/pam_copilot.ts
// for the user-facing mapping.
export class CopilotProviderError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "CopilotProviderError";
  }
}

export type CopilotIntent = "how_to" | "operational";

export interface CopilotRequestPayload {
  intent: CopilotIntent;
  question: string;
  app_guide?: AppGuideEntry[];
  workspace?: PamWorkspaceSummary;
  partner?: PartnerContext | null;
}

export interface CopilotEvidenceItem {
  label: string;
  value: string;
}

export interface CopilotReply {
  answer: string;
  evidence: CopilotEvidenceItem[];
  suggested_route: string | null;
  follow_ups: string[];
}

const CopilotEvidenceItemSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(200),
});

const CopilotReplySchema = z.object({
  answer: z.string().min(1).max(1500),
  evidence: z.array(CopilotEvidenceItemSchema).max(6),
  suggested_route: z.string().max(60).nullable(),
  follow_ups: z.array(z.string().min(1).max(120)).max(4),
});

const MAX_TOKENS = 700;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 50_000;

const SYSTEM_PROMPT = `You are the DRUID Channels & Alliances "Channel Copilot" -- a grounded, read-only assistant for a Partner Alliance Manager (PAM) working inside the DRUID Channels & Alliances app.

You will be given, as a single JSON user message:
- "intent": either "how_to" (a question about how the app works) or "operational" (a question about the PAM's own targets, recruitments, portfolio, or Radar signals).
- "question": the PAM's actual question.
- "app_guide": (how_to questions) a small list of the app's real surfaces -- title, route, purpose, and available actions. This is your ONLY source of truth about what the app can do.
- "workspace": (operational questions) a bounded snapshot of the PAM's own territory -- identity, target/actual performance, top discovery prospects, priority recruitments, partners needing attention, recent Channel Radar signals, recent marketing activity, a deterministic Territory Potential summary (workspace.territory_potential -- discovered/qualified/available prospect counts, existing partners, active recruitments, recent discovery yield, saturation_state, potential_band -- all pre-computed facts, never your own estimate), and explicit data-quality notes about what is missing.
- "partner": (only when the question is about one specific partner company) that company's relationship/recruitment/activity/Radar context.

STRICT RULES:
1. You may only use facts present in the supplied JSON. Never invent a target, actual value, date, status, country, activity, relationship, evidence item, or app feature that isn't there.
2. Unknown means unknown. If a target is missing, say no target is configured -- never substitute zero or a guess. If a date or history item is absent, say you don't have that information rather than estimating one.
3. Distinguish FACT from RECOMMENDATION in your answer's wording. A fact must be something literally present in the supplied data (a target value, a stage, a count). A recommendation is your own synthesis and must read like one (e.g. "I would prioritize...", "The strongest contributing factor I can see is..."). Never phrase a recommendation as if it were a stored fact.
4. If asked "why" something happened (e.g. "why am I behind target"), you may infer a plausible contributing factor ONLY from the supplied data, and must make clear it is inferred, not certain. Never claim a cause not supported by the data (e.g. never say outreach is weak without direct evidence of that).
5. Never claim something happened locally/in this territory when your only evidence is group-level or out of scope. Only speak for what the supplied context actually contains.
6. For how_to questions, answer only from "app_guide". If the PAM asks about a feature that isn't in app_guide, say clearly that it doesn't exist -- never invent a button, page, or workflow. Reference the real route when relevant.
7. You have NO ability to take any action -- you cannot change a target, move a recruitment stage, update a relationship, dismiss a signal, or send anything. Never imply you did or will do so. If asked to perform an action, explain what to do and where, using the supplied data -- never claim you did it.
8. Keep the answer concise -- a few sentences, not an essay. Do not repeat the entire supplied context back verbatim.
9. Territory Potential facts (saturation_state, potential_band, available/qualified counts) describe observed capacity, not a target recommendation. You may point out a factual relationship (e.g. "the available qualified pool is below the configured target"), but never invent or suggest a specific target number (e.g. never say "your target should be 35") -- target-setting is a human decision, not something you calculate or propose.
10. "evidence" is an optional short list of the specific stored facts your answer relies on (e.g. {"label": "Q3 Signed Partners target", "value": "5"}) -- omit it if your answer doesn't hinge on specific numbers/facts. "suggested_route" must be one of the routes present in the supplied app_guide/workspace context, or null. "follow_ups" is at most 4 short suggested next questions, as plain text only -- never a description of an action you'd take.

Respond with ONLY a single JSON object, no markdown, no commentary, matching exactly this shape:
{
  "answer": "string",
  "evidence": [{"label": "string", "value": "string"}],
  "suggested_route": "string or null",
  "follow_ups": ["string", "..."]
}`;

export async function isConfigured(): Promise<boolean> {
  const [conn] = await db.select().from(connectionsTable).where(eq(connectionsTable.providerType, "ai"));
  return process.env.AI_PROVIDER === "deepseek" && hasCredential(conn?.credentialEnvVar ?? null);
}

export async function chat(payload: CopilotRequestPayload): Promise<CopilotReply> {
  if (!(await isConfigured())) throw new CopilotNotConfiguredError();

  switch (process.env.AI_PROVIDER) {
    case "deepseek":
      return chatViaDeepSeek(payload);
    default:
      throw new CopilotNotConfiguredError();
  }
}

// Exported (not just called internally) so it can be unit-tested directly
// against a mocked fetch, without needing a live DB-backed isConfigured()
// check in the test -- same convention as searchViaTavily/qualifyViaDeepSeek.
export async function chatViaDeepSeek(payload: CopilotRequestPayload): Promise<CopilotReply> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new CopilotNotConfiguredError();

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
    throw new CopilotProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new CopilotProviderError("http_error");

  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new CopilotProviderError("oversized_response");
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CopilotProviderError("malformed_json");
  }

  const choice = body?.choices?.[0];
  const rawContent = choice?.message?.content;
  if (!choice || typeof rawContent !== "string" || rawContent.trim() === "") {
    throw new CopilotProviderError("empty_response");
  }
  if (choice.finish_reason === "length") {
    throw new CopilotProviderError("truncated");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new CopilotProviderError("malformed_json");
  }

  const validated = CopilotReplySchema.safeParse(parsed);
  if (!validated.success) throw new CopilotProviderError("schema_invalid");

  return validated.data;
}
