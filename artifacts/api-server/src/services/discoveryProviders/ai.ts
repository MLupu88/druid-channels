// Service boundary for the LLM that structures discovery evidence into the
// qualification schema. DeepSeek is the implemented provider, reusing the
// same AI_PROVIDER=deepseek / AI_API_KEY credential already configured for
// the Overview AI Channel Brief -- but this module's prompt, response
// schema, and hardening are entirely its own (see services/aiBriefProvider.ts
// for that separate feature; deliberately not imported from here).
//
// The LLM must only structure and summarize collected evidence -- it must
// never invent companies or evidence, and every claim it returns must
// reference at least one evidence URL it was given as input.
import { z } from "zod/v4";
import { resolveProviderSecret, hasResolvableCredential } from "../connections";
import { logger } from "../../lib/logger";

export class AiNotImplementedError extends Error {
  constructor() {
    super("AI structuring is not implemented yet. Configure a connection and implement this call before relying on live discovery.");
    this.name = "AiNotImplementedError";
  }
}

// code is a small closed set of internal failure classifications -- never
// the raw provider error text.
export class AiProviderError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "AiProviderError";
  }
}

// The management-configured Partner Search Criteria this candidate is being
// evaluated against -- the same profile that drove the search queries which
// produced `evidence` below (see discoveryEngine.ts's
// buildPartnerSearchCriteria). territoryCountries comes directly from
// territories.countries (the canonical geography source established for
// Partner Search Criteria) -- never a legacy fallback, so Settings and
// qualification can never diverge on geography.
export interface PartnerSearchCriteria {
  partnerTypes: string[];
  industries: string[];
  technologies: string[];
  territoryName: string;
  territoryCountries: string[];
  excludedDomains: string[];
  minChecksRequired: number;
  searchIntent: string[];
  // Signal families this territory's Settings > What to look for is
  // prioritizing (mapped from target_signals -- see discoveryEngine.ts's
  // TARGET_SIGNAL_TO_TYPE). Context only: it informs signal_type
  // classification and framing, but never overrides the evidence-grounded
  // five-check gate -- evidence outside this list is still assessed
  // honestly on its own merits, never rejected just for being unlisted.
  targetSignalTypes: string[];
}

export interface AiQualificationInput {
  companyName: string;
  domain: string;
  evidence: Array<{ url: string; text: string }>;
  // This grounds *why* a check is true/false and the resulting explanation
  // in what DRUID is actually looking for -- it is never license to invent
  // evidence to match the criteria. The five-check qualification gate
  // itself (discoveryEngine.ts's qualifyChecks) remains authoritative; this
  // function only supplies evidence-grounded check assessments.
  criteria: PartnerSearchCriteria;
}

const SIGNAL_TYPES = ["partnership", "ai_investment", "enterprise_access", "technology", "hiring", "event", "tender"] as const;

// Hotfix: recruitment-eligibility archetype. AI classifies WHAT KIND of
// business the evidence subject is (never whether it's eligible -- that
// decision belongs to application code, see discoveryEngine.ts's
// isEligibleRecruitmentArchetype). A closed enum instead of free-text
// partnerType matching -- partnerType stays a free-text display label (e.g.
// "Automation platform vendor"), but eligibility must never be decided by
// substring-matching that string.
export const RECRUITMENT_ARCHETYPES = [
  "system_integrator",
  "consultancy",
  "managed_service_provider",
  "reseller",
  "distributor",
  "implementation_partner",
  "bpo_service_provider",
  "technology_vendor",
  "other",
] as const;
export type RecruitmentArchetype = (typeof RECRUITMENT_ARCHETYPES)[number];

export interface AiQualificationOutput {
  partnerType: string;
  // The evidence subject's business-model classification for DRUID's PAM
  // channel-recruitment program -- see RECRUITMENT_ARCHETYPES. Deliberately
  // independent of technologyAdjacency/relevantCapability below: a company
  // can have strong technology capability and still be a system integrator,
  // reseller, or consultancy, and a technology_vendor can show enterprise
  // access or technology adjacency without that changing its archetype.
  recruitmentArchetype: RecruitmentArchetype;
  // The primary signal family this evidence represents -- used by
  // discoveryEngine.ts to tag the persisted signal row correctly, instead
  // of hardcoding one type for every live-path signal.
  signalType: (typeof SIGNAL_TYPES)[number];
  // The company whose capability/partnership signal this evidence is
  // actually ABOUT -- evidence-grounded, never assumed to be the same as
  // the search result's own page title (a news article's title is the
  // headline, not the subject company's name). See discoveryEngine.ts's
  // identity-resolution step, which uses this rather than the raw title.
  subjectCompanyName: string;
  // True only when the evidence URL/domain is the subject company's own
  // site (blog, newsroom, partner page). False for news sites, analyst
  // firms, PR wires, event listings, directories, or tender portals --
  // i.e. any third-party publisher, which is never the company's own domain.
  sourceIsFirstParty: boolean;
  enterpriseAccess: boolean;
  relevantCapability: boolean;
  technologyAdjacency: boolean;
  partnershipOpenness: boolean;
  recentTrigger: boolean;
  whyItFits: string;
  whyNow: string;
  suggestedAngle: string;
  suggestedTargetRole: string;
  suggestedMessage: string;
  // Must be a subset of the URLs present in AiQualificationInput.evidence --
  // an implementation must never invent a source URL that wasn't given to it.
  evidenceUrls: string[];
}

const AiQualificationSchema = z.object({
  partner_type: z.string().min(1).max(120),
  recruitment_archetype: z.enum(RECRUITMENT_ARCHETYPES),
  signal_type: z.enum(SIGNAL_TYPES),
  subject_company_name: z.string().min(1).max(200),
  source_is_first_party: z.boolean(),
  enterprise_access: z.boolean(),
  relevant_capability: z.boolean(),
  technology_adjacency: z.boolean(),
  partnership_openness: z.boolean(),
  recent_trigger: z.boolean(),
  why_it_fits: z.string().min(1).max(500),
  why_now: z.string().min(1).max(500),
  suggested_angle: z.string().min(1).max(300),
  suggested_target_role: z.string().min(1).max(120),
  suggested_message: z.string().min(1).max(600),
  evidence_urls: z.array(z.string()),
});

const MAX_TOKENS = 900;
// Production hotfix: the main qualification call (qualifyViaDeepSeek) and
// the much smaller identity-resolution call (identifyCompanyViaDeepSeek)
// previously shared one 20s timeout. A real CEE scan's qualification call
// legitimately needs more headroom than a 3-candidate identity lookup, so
// they're now independently bounded -- this is strictly a timeout-budget
// split; the request body (model, thinking, response_format, max_tokens)
// for each call is unchanged.
export const QUALIFICATION_TIMEOUT_MS = 60_000;
export const IDENTITY_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 50_000;

const SYSTEM_PROMPT = `You are an assistant that evaluates whether a company found via a web search is a good potential channel/alliance partner for DRUID, an enterprise conversational/agentic AI platform vendor.

You will be given:
- The company's name and domain, as returned by search (not independently verified).
- Evidence: one or more {url, text} pairs -- actual text found on the web about this company. This is your ONLY source of truth. Never invent a fact, event, product, partnership, or capability not present in this text.
- Partner Search Criteria this evaluation is being run against (target partner types, industries, technologies, territory, and target_signal_types -- the signal families this territory is prioritizing, e.g. partnership announcements or tenders).

target_signal_types is context, not a filter: use it to inform signal_type classification and how you frame why_now, but never reject or downgrade evidence just because its signal_type falls outside that list, and never fabricate a signal to match it. The five-check gate remains authoritative regardless of target_signal_types.

Assess exactly five yes/no checks, each grounded in the supplied evidence text -- never inferred from the company name or domain alone:
- enterprise_access: evidence the company already serves enterprise/large customers.
- relevant_capability: evidence of AI, automation, or a relevant technology delivery capability.
- technology_adjacency: evidence of a partnership/certification/integration with one of the criteria's listed technologies, or a comparable adjacent platform.
- partnership_openness: evidence the company is open to, or actively building, a partner/alliance program.
- recent_trigger: evidence of a recent (roughly within the last year) event -- funding, acquisition, new practice launch, hiring wave, contract win, etc.

If the evidence does not support a check, mark it false. Do not guess yes to be helpful.

recruitment_archetype classifies the evidence subject's BUSINESS MODEL for DRUID's PAM channel-recruitment program -- this is about how the company makes money and delivers to its own customers, never about which technologies it uses, integrates with, or is adjacent to. Choose exactly one:
- system_integrator: builds/integrates enterprise IT solutions for clients, often spanning multiple vendors' platforms.
- consultancy: advises on and implements enterprise technology/process change for clients; not the platform owner.
- managed_service_provider: operates/manages IT or business-process systems for clients on an ongoing basis.
- reseller: sells/resells third-party technology products to end customers.
- distributor: distributes third-party technology products to a reseller/partner network.
- implementation_partner: implements/deploys a specific technology platform for clients -- not that platform's own vendor.
- bpo_service_provider: delivers business-process outsourcing (e.g. contact center) services, whether on its own or third-party technology.
- technology_vendor: the subject's own core business is DEVELOPING AND SELLING its own software, platform, or product -- e.g. an automation platform vendor, an ERP vendor, a CCaaS/contact-center platform vendor, or any company whose product is what a channel partner would resell/integrate/implement, rather than the channel partner itself. Evidence of enterprise customers, integrations, partner programs, or technology adjacency does NOT change this classification if the subject's own core business is selling its own platform -- e.g. UiPath, Microsoft, SAP, and Genesys are all technology_vendor regardless of how many integrations or partners they have.
- other: none of the above clearly applies, or the evidence does not support a confident classification.

Never let technology_adjacency, relevant_capability, or enterprise_access influence recruitment_archetype. A company can have strong technology capability and still be a system_integrator, reseller, consultancy, or implementation_partner rather than a technology_vendor; a technology_vendor can show enterprise access or technology adjacency evidence without that changing its archetype.

signal_type must be the single best-fitting category for the primary evidence you were given: partnership, ai_investment, enterprise_access, technology, hiring, event, or tender.

subject_company_name is the company whose capability/partnership/signal this evidence is actually ABOUT -- read the evidence text itself to determine this. Never assume it is the same as the page title or the domain hosting the evidence. For example, a news article on an analyst site titled "Acme Corp announces X" is evidence about Acme Corp, not about the analyst site that published it.

source_is_first_party is true only if the evidence URL/domain appears to be the subject company's own website (their own blog, newsroom, partner page, careers page). It is false for news sites, analyst firms, PR wire services, event listing sites, partner directories, tender/procurement portals, or any other third-party publisher.

evidence_urls must be a subset of the URLs you were actually given as evidence -- never a URL you were not given.

Respond with ONLY a single JSON object, no markdown, no commentary, matching exactly this shape:

{
  "partner_type": "string, e.g. 'System integrator', 'Value added reseller', 'AI consultancy'",
  "recruitment_archetype": "system_integrator | consultancy | managed_service_provider | reseller | distributor | implementation_partner | bpo_service_provider | technology_vendor | other",
  "signal_type": "partnership | ai_investment | enterprise_access | technology | hiring | event | tender",
  "subject_company_name": "string -- the company this evidence is actually about",
  "source_is_first_party": boolean,
  "enterprise_access": boolean,
  "relevant_capability": boolean,
  "technology_adjacency": boolean,
  "partnership_openness": boolean,
  "recent_trigger": boolean,
  "why_it_fits": "string, at most 500 characters, grounded in the evidence",
  "why_now": "string, at most 500 characters -- the recent trigger, or state there isn't one",
  "suggested_angle": "string, at most 300 characters -- a plausible DRUID partnership angle given this company's capability",
  "suggested_target_role": "string, at most 120 characters -- a plausible job title to reach out to",
  "suggested_message": "string, at most 600 characters -- a short, evidence-grounded opening outreach line",
  "evidence_urls": ["url1", "..."]
}`;

// Deliberately its own small check, not a cross-import from
// aiBriefProvider.ts -- same underlying AI_PROVIDER/connections row, but
// this module's provider boundary stays independently maintainable rather
// than coupling two features that may diverge later (e.g. if the AI Brief
// moves to an n8n-backed implementation while Discovery stays on direct
// DeepSeek).
// Phase 11.5B: resolution now goes through resolveProviderSecret (DB secret
// -> credentialEnvVar -> unavailable, honoring enabled=false) instead of a
// hardcoded process.env.AI_API_KEY read -- see services/connections.ts.
export async function isConfigured(): Promise<boolean> {
  return process.env.AI_PROVIDER === "deepseek" && (await hasResolvableCredential("ai"));
}

export async function qualify(input: AiQualificationInput): Promise<AiQualificationOutput> {
  if (!(await isConfigured())) throw new AiNotImplementedError();

  switch (process.env.AI_PROVIDER) {
    case "deepseek": {
      const apiKey = await resolveProviderSecret("ai");
      if (!apiKey) throw new AiNotImplementedError();
      return qualifyViaDeepSeek(apiKey, input);
    }
    default:
      throw new AiNotImplementedError();
  }
}

// Exported (not just called internally) so it can be unit-tested directly
// against a mocked fetch, without needing a live DB-backed isConfigured()
// check in the test. apiKey is now an explicit parameter rather than read
// from process.env internally.
export async function qualifyViaDeepSeek(apiKey: string, input: AiQualificationInput): Promise<AiQualificationOutput> {

  const payload = {
    company_name: input.companyName,
    domain: input.domain,
    evidence: input.evidence,
    criteria: {
      partner_types: input.criteria.partnerTypes,
      industries: input.criteria.industries,
      technologies: input.criteria.technologies,
      territory_name: input.criteria.territoryName,
      territory_countries: input.criteria.territoryCountries,
      target_signal_types: input.criteria.targetSignalTypes,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUALIFICATION_TIMEOUT_MS);
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
    throw new AiProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new AiProviderError("http_error");

  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new AiProviderError("oversized_response");
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AiProviderError("malformed_json");
  }

  const choice = body?.choices?.[0];
  const rawContent = choice?.message?.content;
  if (!choice || typeof rawContent !== "string" || rawContent.trim() === "") {
    throw new AiProviderError("empty_response");
  }
  if (choice.finish_reason === "length") {
    throw new AiProviderError("truncated");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new AiProviderError("malformed_json");
  }

  const validated = AiQualificationSchema.safeParse(parsed);
  if (!validated.success) throw new AiProviderError("schema_invalid");

  const validEvidenceUrls = new Set(input.evidence.map((e) => e.url));
  const filteredEvidenceUrls = validated.data.evidence_urls.filter((url) => validEvidenceUrls.has(url));
  if (filteredEvidenceUrls.length !== validated.data.evidence_urls.length) {
    logger.warn(
      { dropped: validated.data.evidence_urls.length - filteredEvidenceUrls.length },
      "Discovery AI qualification: filtered invalid evidence URL reference(s)",
    );
  }

  return {
    partnerType: validated.data.partner_type,
    recruitmentArchetype: validated.data.recruitment_archetype,
    signalType: validated.data.signal_type,
    subjectCompanyName: validated.data.subject_company_name,
    sourceIsFirstParty: validated.data.source_is_first_party,
    enterpriseAccess: validated.data.enterprise_access,
    relevantCapability: validated.data.relevant_capability,
    technologyAdjacency: validated.data.technology_adjacency,
    partnershipOpenness: validated.data.partnership_openness,
    recentTrigger: validated.data.recent_trigger,
    whyItFits: validated.data.why_it_fits,
    whyNow: validated.data.why_now,
    suggestedAngle: validated.data.suggested_angle,
    suggestedTargetRole: validated.data.suggested_target_role,
    suggestedMessage: validated.data.suggested_message,
    evidenceUrls: filteredEvidenceUrls,
  };
}

// ---- Company identity resolution (Stage 3 completion) --------------------
// Only invoked (by discoveryEngine.ts) for third-party evidence about a
// candidate that already passed qualification -- never for every result.
// This is a small, separate DeepSeek call with its own prompt/schema: it
// must pick from the supplied Tavily identity-search candidates only, and
// must never recall a domain from its own general knowledge.

export interface IdentitySearchCandidate {
  url: string;
  title: string;
  snippet: string;
}

export interface IdentityResolutionInput {
  subjectCompanyName: string;
  candidates: IdentitySearchCandidate[];
}

export interface ResolvedIdentity {
  name: string;
  domain: string;
}

const IdentityResolutionSchema = z.object({
  resolved: z.boolean(),
  name: z.string().max(200).nullable(),
  domain: z.string().max(255).nullable(),
});

const IDENTITY_MAX_TOKENS = 200;

const IDENTITY_SYSTEM_PROMPT = `You are given a company name and up to 3 web search results returned for the query: "<company name>" official website.

Using ONLY the supplied candidates (title, url, snippet), determine which one (if any) is that company's own official website, and extract its domain.

Rules:
- You may only use the supplied candidates. Never invent, guess, or recall a domain from your own general knowledge, even if you recognize the company.
- If none of the supplied candidates is clearly that company's own official site (e.g. all are unrelated, or all are third-party directories, social profiles, or news about the company rather than the company's own site), respond with resolved: false and name/domain: null.
- If confident, respond with resolved: true, name being the company's real/canonical name (from the winning candidate), and domain being that candidate's registrable domain (e.g. "acme.com", not the full URL).

Respond with ONLY a single JSON object, no markdown, no commentary, matching exactly this shape:
{ "resolved": boolean, "name": string | null, "domain": string | null }`;

export async function identifyCompany(input: IdentityResolutionInput): Promise<ResolvedIdentity | null> {
  if (!(await isConfigured())) throw new AiNotImplementedError();

  switch (process.env.AI_PROVIDER) {
    case "deepseek": {
      const apiKey = await resolveProviderSecret("ai");
      if (!apiKey) throw new AiNotImplementedError();
      return identifyCompanyViaDeepSeek(apiKey, input);
    }
    default:
      throw new AiNotImplementedError();
  }
}

// apiKey is now an explicit parameter rather than read from process.env
// internally (see qualifyViaDeepSeek's comment above).
export async function identifyCompanyViaDeepSeek(apiKey: string, input: IdentityResolutionInput): Promise<ResolvedIdentity | null> {

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
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
        max_tokens: IDENTITY_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: IDENTITY_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ subject_company_name: input.subjectCompanyName, candidates: input.candidates }) },
        ],
      }),
    });
  } catch (err) {
    throw new AiProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new AiProviderError("http_error");

  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new AiProviderError("oversized_response");
  }

  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AiProviderError("malformed_json");
  }

  const choice = body?.choices?.[0];
  const rawContent = choice?.message?.content;
  if (!choice || typeof rawContent !== "string" || rawContent.trim() === "") {
    throw new AiProviderError("empty_response");
  }
  if (choice.finish_reason === "length") {
    throw new AiProviderError("truncated");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new AiProviderError("malformed_json");
  }

  const validated = IdentityResolutionSchema.safeParse(parsed);
  if (!validated.success) throw new AiProviderError("schema_invalid");
  if (!validated.data.resolved || !validated.data.name || !validated.data.domain) return null;

  return { name: validated.data.name, domain: validated.data.domain };
}

const TEST_TIMEOUT_MS = 15_000;

// Phase 11.5B: the real "Test connection" verification -- a single,
// minimal, bounded DeepSeek completion (max_tokens: 1, no JSON-mode
// response schema, nothing evidence-shaped), hitting the exact same
// endpoint/auth header as a real qualification call so the test proves the
// credential actually authenticates, without spending a real qualification
// call's token budget. Throws AiProviderError on failure; the caller
// (routes/connections.ts) maps success/failure to a status.
export async function testConnection(apiKey: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
  } catch (err) {
    throw new AiProviderError(err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new AiProviderError("http_error");
}
