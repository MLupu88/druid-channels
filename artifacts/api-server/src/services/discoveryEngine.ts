import { db } from "@workspace/db";
import {
  companiesTable,
  signalsTable,
  prospectsTable,
  prospectActivityTable,
  partnerRelationshipsTable,
  scanRunsTable,
  scanConfigsTable,
  territoriesTable,
  connectionsTable,
  SCAN_RUN_STOPPED_REASONS,
  type ScanConfig,
  type Territory,
} from "@workspace/db";
import { eq, and, ne, inArray, isNotNull, sql } from "drizzle-orm";
import { hasCredential } from "./connections";
import * as searchProvider from "./discoveryProviders/search";
import * as extractionProvider from "./discoveryProviders/extraction";
import * as aiProvider from "./discoveryProviders/ai";
import { toRegistrableDomain, isKnownNonCorporateDomain } from "./companyIdentity";
import { loadActiveExclusionDomains, isDomainExcluded } from "./discoveryExclusions";
import { recordDiscoveryEvaluation, loadRecentEvaluationRecords } from "./discoveryEvaluations";
import {
  decideNextBatch,
  computeNewCandidateYield,
  shouldReuseExistingQualification,
  QUERIES_PER_BATCH,
  MAX_CANDIDATES_TO_LLM,
  type BudgetStopReason,
  type ExistingQualificationRecord,
} from "./discoveryBudget";
import { listTrustedDruidFacts, formatTrustedDruidContext } from "./druidFacts";
import { logger } from "../lib/logger";

// The Channel Discovery engine: turns a scan config into real, evidence-backed
// prospects. Tries a live provider chain (web search -> web reader -> AI
// structuring) when all three connections are credentialed; falls back to a
// deterministic demo generator otherwise. Every run is tagged with the data
// status that actually produced it -- never fabricated as "connected".

export type SignalType = "partnership" | "ai_investment" | "enterprise_access" | "technology" | "hiring" | "event" | "tender";
export type Confidence = "high" | "medium" | "low";

export interface FiveChecks {
  enterpriseAccess: boolean;
  relevantCapability: boolean;
  technologyAdjacency: boolean;
  partnershipOpenness: boolean;
  recentTrigger: boolean;
}

export interface CandidateSignal {
  signalType: SignalType;
  title: string;
  summary: string;
  sourceUrl: string;
  sourceDomain: string;
  // Nullable: Tavily's search response carries no per-result publish date,
  // and this is never fabricated as "today" -- honestly null on the live
  // path when the provider doesn't supply one. The demo generator below
  // still produces a real (synthetic-but-consistent) date for demo mode.
  publishedAt: string | null;
  confidence: Confidence;
  rawExcerpt: string | null;
}

export interface Candidate {
  companyName: string;
  domain: string;
  country: string;
  partnerType: string;
  // Hotfix: the business-model classification that decides recruitment
  // eligibility -- see isEligibleRecruitmentArchetype below. Deliberately
  // separate from partnerType (a free-text display label): eligibility must
  // never be decided by substring-matching partnerType.
  recruitmentArchetype: aiProvider.RecruitmentArchetype;
  checks: FiveChecks;
  whyItFits: string;
  whyNow: string;
  suggestedAngle: string;
  suggestedTargetRole: string;
  signals: CandidateSignal[];
}

// ---- Recruitment eligibility (hotfix on top of Phase 3A) ------------------
//
// Product rule: pure technology/software/platform vendors (the evidence
// subject's own core business is developing and selling its own product --
// UiPath, Microsoft, SAP, Genesys-style companies) must never become a PAM
// recruitment Discovery prospect in this motion. System integrators,
// consultancies, MSPs, resellers, distributors, implementation partners,
// and BPO/services providers remain eligible -- including ones with strong
// technology capability/adjacency (see FiveChecks.technologyAdjacency,
// which stays completely independent of this gate; see also the
// AiQualificationOutput.recruitmentArchetype doc comment in
// discoveryProviders/ai.ts).
//
// The AI only classifies (recruitmentArchetype); this set is the actual
// eligibility decision, owned entirely by application code, never by the
// model. "technology_vendor" and "other" are both deliberately excluded --
// an unclassifiable/ambiguous evidence subject never silently becomes an
// eligible prospect. There is currently no structured signal this gate can
// use to make an exception for "other" ("clear qualifying channel-delivery
// evidence"), so it stays excluded by default; revisit if that proves too
// strict in practice.
const ELIGIBLE_RECRUITMENT_ARCHETYPES: ReadonlySet<aiProvider.RecruitmentArchetype> = new Set([
  "system_integrator",
  "consultancy",
  "managed_service_provider",
  "reseller",
  "distributor",
  "implementation_partner",
  "bpo_service_provider",
]);

export function isEligibleRecruitmentArchetype(archetype: aiProvider.RecruitmentArchetype): boolean {
  return ELIGIBLE_RECRUITMENT_ARCHETYPES.has(archetype);
}

// ---- Qualification (product spec section 10) ----------------------------

export function countChecks(c: FiveChecks): number {
  return [c.enterpriseAccess, c.relevantCapability, c.technologyAdjacency, c.partnershipOpenness, c.recentTrigger].filter(Boolean).length;
}

export interface QualificationResult {
  priority: "A" | "B" | null;
  rationale: string;
}

export function qualifyChecks(c: FiveChecks, minChecksRequired: number): QualificationResult {
  const count = countChecks(c);
  if (count < minChecksRequired) {
    return { priority: null, rationale: `Only ${count} of 5 checks passed (this territory requires at least ${minChecksRequired}).` };
  }
  if (!c.enterpriseAccess) return { priority: null, rationale: "No enterprise-access evidence found." };
  if (!c.relevantCapability) return { priority: null, rationale: "No relevant-capability evidence found." };
  if (count >= 4 && (c.partnershipOpenness || c.recentTrigger)) {
    const routeText =
      c.partnershipOpenness && c.recentTrigger
        ? "both partnership openness and a recent trigger"
        : c.partnershipOpenness
          ? "partnership openness"
          : "a recent trigger";
    return {
      priority: "A",
      rationale: `${count} of 5 checks passed, with confirmed enterprise access, relevant capability, and ${routeText}.`,
    };
  }
  if (count === 3) {
    return {
      priority: "B",
      rationale: "3 of 5 checks passed, with confirmed enterprise access and relevant capability, but a weaker timing or partnership route.",
    };
  }
  return { priority: null, rationale: `${count} of 5 checks passed, but not enough evidence for either a Priority A or Priority B pattern.` };
}

// ---- Demo candidate generation -------------------------------------------

interface SignalKind {
  id: string;
  signalType: SignalType;
  evidenceFor: Array<keyof FiveChecks>;
  urlPath: string;
  title: (name: string, ctx: GenContext) => string;
  summary: (name: string, ctx: GenContext) => string;
  excerpt: (name: string, ctx: GenContext) => string;
  targetRole: string;
  angleFallback: string;
}

interface Archetype {
  id: string;
  label: string;
  // Every demo archetype is, by construction, a channel-eligible business
  // model (never a technology_vendor) -- see isEligibleRecruitmentArchetype.
  recruitmentArchetype: aiProvider.RecruitmentArchetype;
  adjacencies: string[];
  industries: string[];
  druidAngle: string;
  namePool: string[];
  suffixPool: string[];
}

interface GenContext {
  archetype: Archetype;
  tech: string;
  industry: string;
  territory: string;
}

const ARCHETYPES: Archetype[] = [
  {
    id: "contact_center_integrator",
    label: "Contact-center integrator",
    recruitmentArchetype: "system_integrator",
    adjacencies: ["Genesys", "NiCE", "Cisco", "Amazon Connect", "Five9", "Avaya"],
    industries: ["Banking", "Insurance", "Retail"],
    druidAngle: "Add an enterprise AI-agent and process-completion layer to the firm's existing contact-center transformation programs.",
    namePool: ["Northbridge", "Meridian", "Anchorline", "Vantage", "Solstice", "Fieldstone"],
    suffixPool: ["Contact Systems", "CX Group", "Voice Technologies"],
  },
  {
    id: "automation_workflow_specialist",
    label: "Automation & workflow specialist",
    recruitmentArchetype: "implementation_partner",
    adjacencies: ["UiPath", "ServiceNow", "Microsoft Power Platform", "Salesforce", "SAP", "Oracle"],
    industries: ["Healthcare", "Higher education", "Banking"],
    druidAngle: "Give the firm's customers and employees a conversational way to access and orchestrate the workflows it already automates.",
    namePool: ["Brightline", "Elevate", "Novara", "Corewave", "Pathforge", "Ridgeline"],
    suffixPool: ["Automation Partners", "Digital Workflows", "Process Consulting"],
  },
  {
    id: "ai_data_consultancy",
    label: "AI & data consultancy",
    recruitmentArchetype: "consultancy",
    adjacencies: ["Microsoft", "AWS", "Google Cloud", "NVIDIA"],
    industries: ["Retail", "Banking", "Healthcare"],
    druidAngle: "Move the firm from AI advisory and prototypes to production-grade enterprise AI agents.",
    namePool: ["Lumenova", "Datashift", "Cognivant", "Insightra", "Nexalytics", "Trueline"],
    suffixPool: ["AI Consulting", "Data & AI", "Analytics Group"],
  },
  {
    id: "bpo_managed_service",
    label: "BPO / managed service provider",
    recruitmentArchetype: "bpo_service_provider",
    adjacencies: ["Genesys", "ServiceNow", "Salesforce"],
    industries: ["Banking", "Healthcare", "Insurance"],
    druidAngle: "Package DRUID's AI agents inside the firm's recurring managed-service proposition.",
    namePool: ["Anchorpoint", "Summit", "Continuum", "Everbridge", "Keystone", "Farlight"],
    suffixPool: ["Managed Services", "Operations Group", "Support Solutions"],
  },
  {
    id: "telco_msp",
    label: "Telco / enterprise MSP",
    recruitmentArchetype: "managed_service_provider",
    adjacencies: ["Cisco", "Microsoft", "AWS"],
    industries: ["Retail", "Banking", "Public sector"],
    druidAngle: "Combine DRUID with the firm's cloud, communications, and managed-services stack for enterprise customers.",
    namePool: ["Wavepoint", "Circuitline", "Meshworks", "Signalbridge", "Fibercore", "Netform"],
    suffixPool: ["Communications", "Enterprise Networks", "Managed Cloud"],
  },
  {
    id: "vertical_specialist",
    label: "Vertical specialist",
    recruitmentArchetype: "consultancy",
    adjacencies: ["Salesforce", "SAP", "Microsoft"],
    industries: ["Banking", "Insurance", "Healthcare", "Higher education", "Retail"],
    druidAngle: "Combine DRUID's platform and pre-built AI-agent starting points with the firm's domain expertise and customer access.",
    namePool: ["Cardinal", "Westbrook", "Harborline", "Ashford", "Millbrook", "Stonegate"],
    suffixPool: ["Advisory", "Consulting Group", "Solutions"],
  },
];

const SIGNAL_KINDS: SignalKind[] = [
  {
    id: "new_ai_practice",
    signalType: "ai_investment",
    evidenceFor: ["relevantCapability", "recentTrigger"],
    urlPath: "/news/new-ai-practice",
    title: (name) => `${name} launches a generative AI practice`,
    summary: (name) => `${name} announced a new generative/agentic AI practice for enterprise customers, including a dedicated delivery team.`,
    excerpt: (name) => `"${name} today announced the launch of its enterprise AI practice, bringing agentic AI capability to its existing client base."`,
    targetRole: "Head of AI",
    angleFallback: "Move from AI advisory and prototypes to production-grade enterprise AI agents.",
  },
  {
    id: "tech_partner_program",
    signalType: "partnership",
    evidenceFor: ["partnershipOpenness"],
    urlPath: "/partners/technology-alliance-program",
    title: (name) => `${name} opens a technology partner program`,
    summary: (name) => `${name} published a public technology-partner / alliance program inviting ISV and platform partners to apply.`,
    excerpt: () => `"We are actively growing our technology alliance ecosystem and welcome applications from platform partners."`,
    targetRole: "Head of Alliances",
    angleFallback: "Explore DRUID as a platform partner for enterprise AI-agent solutions.",
  },
  {
    id: "enterprise_case_study",
    signalType: "enterprise_access",
    evidenceFor: ["enterpriseAccess"],
    urlPath: "/customers/enterprise-case-study",
    title: (name, ctx) => `${name} publishes a ${ctx.industry.toLowerCase()} customer case study`,
    summary: (name, ctx) => `${name}'s newsroom features a case study with a ${ctx.industry.toLowerCase()} enterprise customer, describing a multi-country deployment.`,
    excerpt: (name, ctx) => `"${name} delivered a multi-country ${ctx.industry.toLowerCase()} transformation program for one of the region's largest enterprise accounts."`,
    targetRole: "VP Partnerships",
    angleFallback: "Extend the partner's vertical offering with DRUID's relevant industry use cases.",
  },
  {
    id: "tech_adjacency_cert",
    signalType: "technology",
    evidenceFor: ["technologyAdjacency"],
    urlPath: "/partners/certifications",
    title: (name, ctx) => `${name} achieves advanced ${ctx.tech} partner status`,
    summary: (name, ctx) => `${name}'s partner page lists an advanced/premier certification with ${ctx.tech}, positioning it inside that ecosystem.`,
    excerpt: (name, ctx) => `"${name} is proud to be recognized as an Advanced ${ctx.tech} partner."`,
    targetRole: "Managing Director",
    angleFallback: "Add a conversational interface and agent layer to the partner's existing technology stack.",
  },
  {
    id: "ai_hiring_cluster",
    signalType: "hiring",
    evidenceFor: ["recentTrigger", "relevantCapability"],
    urlPath: "/careers",
    title: (name) => `${name} is hiring multiple AI roles`,
    summary: (name) => `${name}'s careers page lists several open roles (Conversational AI Consultant, Agentic AI Lead) posted within the last quarter.`,
    excerpt: () => `"We're growing our AI practice -- open roles include Agentic AI Lead and Conversational AI Consultant."`,
    targetRole: "AI Practice Director",
    angleFallback: "Reduce time to market with an existing enterprise AI-agent platform.",
  },
  {
    id: "event_speaker",
    signalType: "event",
    evidenceFor: ["recentTrigger", "partnershipOpenness"],
    urlPath: "/events/enterprise-ai-summit",
    title: (name) => `${name} speaks at an enterprise AI event`,
    summary: (name, ctx) => `${name} presented alongside a ${ctx.tech} ecosystem session on enterprise AI adoption.`,
    excerpt: (name, ctx) => `"${name}'s session covered how enterprise customers are adopting agentic AI within their ${ctx.tech} environments."`,
    targetRole: "Head of Alliances",
    angleFallback: "Continue the partner's public point of view through a joint customer proposition.",
  },
  {
    id: "contract_award",
    signalType: "tender",
    evidenceFor: ["enterpriseAccess", "recentTrigger"],
    urlPath: "/news/contract-award",
    title: (name) => `${name} wins a public-sector automation contract`,
    summary: (name) => `${name} was named as a supplier on a recent public contract award for customer-service automation.`,
    excerpt: (name) => `"${name} has been awarded a multi-year contract to modernize customer-service operations."`,
    targetRole: "Business Development Director",
    angleFallback: "Explore DRUID for multilingual, hybrid, or on-premise enterprise requirements.",
  },
  {
    id: "acquisition",
    signalType: "ai_investment",
    evidenceFor: ["relevantCapability", "recentTrigger"],
    urlPath: "/news/acquisition",
    title: (name) => `${name} acquires an AI consultancy`,
    summary: (name) => `${name} announced the acquisition of a boutique AI consultancy to accelerate its enterprise AI offering.`,
    excerpt: () => `"This acquisition accelerates our roadmap to deliver production-grade enterprise AI agents."`,
    targetRole: "Head of AI",
    angleFallback: "Accelerate the acquired capability with a production-ready AI-agent platform.",
  },
];

const FALLBACK_COUNTRIES_BY_TERRITORY: Record<string, string[]> = {
  "UK & Ireland": ["United Kingdom", "Ireland"],
  DACH: ["Germany", "Austria", "Switzerland"],
  "Central and Eastern Europe": ["Poland", "Romania", "Czech Republic", "Hungary"],
  "United States": ["United States"],
  "Portugal, Canada and South America": ["Portugal", "Canada", "Brazil"],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function pickN<T>(arr: T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickConfidence(): Confidence {
  const r = Math.random();
  if (r < 0.3) return "high";
  if (r < 0.9) return "medium";
  return "low";
}

function randomDateWithin(days: number): string {
  const clamped = Math.max(7, Math.min(days, 365));
  const d = new Date();
  d.setDate(d.getDate() - randomInt(1, clamped));
  return d.toISOString().slice(0, 10);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveCountries(territory: Territory): string[] {
  const configured = (territory.countries as string[]) ?? [];
  if (configured.length > 0) return configured;
  return FALLBACK_COUNTRIES_BY_TERRITORY[territory.name] ?? ["Global"];
}

function matchesConfigFilter(archetype: Archetype, config: ScanConfig): boolean {
  const partnerTypes = (config.partnerTypes as string[]) ?? [];
  const industries = (config.industries as string[]) ?? [];
  const technologies = (config.technologies as string[]) ?? [];
  if (partnerTypes.length > 0 && !partnerTypes.some((t) => archetype.label.toLowerCase().includes(t.toLowerCase()) || archetype.id.includes(slugify(t)))) {
    return false;
  }
  if (industries.length > 0 && !industries.some((i) => archetype.industries.some((ai) => ai.toLowerCase() === i.toLowerCase()))) {
    return false;
  }
  if (technologies.length > 0 && !technologies.some((t) => archetype.adjacencies.some((a) => a.toLowerCase() === t.toLowerCase()))) {
    return false;
  }
  return true;
}

function generateCandidate(config: ScanConfig, territory: Territory, usedDomains: Set<string>): Candidate {
  const filtered = ARCHETYPES.filter((a) => matchesConfigFilter(a, config));
  const archetype = pick(filtered.length > 0 ? filtered : ARCHETYPES);
  const tech = pick(archetype.adjacencies);
  const industry = pick(archetype.industries);
  const country = pick(resolveCountries(territory));
  const ctx: GenContext = { archetype, tech, industry, territory: territory.name };

  const namePart = pick(archetype.namePool);
  const suffixPart = pick(archetype.suffixPool);
  const companyName = `${namePart} ${suffixPart}`;
  let domain = `${slugify(namePart)}${slugify(suffixPart)}.com`;
  let guard = 0;
  while (usedDomains.has(domain) && guard < 10) {
    domain = `${slugify(namePart)}${slugify(suffixPart)}${randomInt(2, 99)}.com`;
    guard++;
  }
  usedDomains.add(domain);

  const kindCount = randomInt(2, 4);
  const kinds = pickN(SIGNAL_KINDS, kindCount);

  const checks: FiveChecks = {
    enterpriseAccess: false,
    relevantCapability: false,
    technologyAdjacency: false,
    partnershipOpenness: false,
    recentTrigger: false,
  };
  for (const kind of kinds) {
    for (const check of kind.evidenceFor) checks[check] = true;
  }

  const signals: CandidateSignal[] = kinds.map((kind) => ({
    signalType: kind.signalType,
    title: kind.title(companyName, ctx),
    summary: kind.summary(companyName, ctx),
    sourceUrl: `https://${domain}${kind.urlPath}`,
    sourceDomain: domain,
    publishedAt: randomDateWithin(config.recencyWindowDays),
    confidence: pickConfidence(),
    rawExcerpt: kind.excerpt(companyName, ctx),
  }));

  const triggerKind = kinds.find((k) => k.evidenceFor.includes("recentTrigger"));
  const partnershipKind = kinds.find((k) => k.id === "tech_partner_program");

  const whyItFits = checks.enterpriseAccess && checks.technologyAdjacency
    ? `Enterprise ${tech} partner with ${industry.toLowerCase()} customer references.`
    : checks.enterpriseAccess
      ? `Works with enterprise ${industry.toLowerCase()} customers, with an emerging ${archetype.label.toLowerCase()} capability.`
      : `${archetype.label} with a relevant ${tech} adjacency, but enterprise customer access is not yet confirmed.`;

  const whyNow = triggerKind ? triggerKind.summary(companyName, ctx) : `No new trigger identified yet -- evidence is based on capability and partnership signals only.`;

  const suggestedAngle = partnershipKind ? partnershipKind.angleFallback : archetype.druidAngle;
  const suggestedTargetRole = (triggerKind ?? partnershipKind ?? kinds[0])!.targetRole;

  return {
    companyName,
    domain,
    country,
    partnerType: archetype.label,
    recruitmentArchetype: archetype.recruitmentArchetype,
    checks,
    whyItFits,
    whyNow,
    suggestedAngle,
    suggestedTargetRole,
    signals,
  };
}

function generateDemoCandidates(config: ScanConfig, territory: Territory): Candidate[] {
  const count = Math.min(config.maxResults, randomInt(4, 10));
  const usedDomains = new Set<string>();
  return Array.from({ length: count }, () => generateCandidate(config, territory, usedDomains));
}

// ---- Live provider chain (dormant until a provider is implemented) -------

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Bounded, realistic search-phrase variants per partner-type category --
// diversity for the round-robin planner below, never a multiplier on query
// count (variants are rotated through by index, never cross-joined).
const PARTNER_TYPE_SEARCH_TERMS: Record<string, string[]> = {
  "system integrator": ["systems integrator", "implementation partner", "technology consultancy"],
  si: ["systems integrator", "implementation partner"],
  "value added reseller": ["value added reseller", "technology reseller", "solution provider"],
  var: ["value added reseller", "technology reseller", "solution provider"],
  isv: ["ISV", "independent software vendor"],
  consulting: ["consultancy", "advisory firm"],
  "managed service provider": ["managed services provider", "managed IT services"],
  msp: ["managed services provider", "managed IT services"],
  bpo: ["BPO", "business process outsourcer"],
};

function partnerTypeSearchVariants(raw: string): string[] {
  return PARTNER_TYPE_SEARCH_TERMS[raw.trim().toLowerCase()] ?? [raw]; // unknown categories pass through literally
}

// Maps Settings "What to look for" target_signals ids to the canonical
// signals.signal_type taxonomy -- used both for search-query phrasing below
// and for the qualification context passed to DeepSeek (see
// buildPartnerSearchCriteria). new_partners has no direct signal-type
// equivalent -- it's a general "run discovery" toggle, not a specific
// signal family, so it's intentionally left unmapped rather than forced
// onto one of the seven real types.
const TARGET_SIGNAL_TO_TYPE: Record<string, SignalType> = {
  partnerships: "partnership",
  ai_moves: "ai_investment",
  rfps: "tender",
  events: "event",
  customer_wins: "enterprise_access",
};

const TARGET_SIGNAL_SEARCH_TERMS: Record<string, string> = {
  partnerships: "partner program",
  ai_moves: "AI investment",
  rfps: "tender contract award",
  events: "industry event",
  customer_wins: "enterprise customer",
};

// Exported for testing -- pure, no DB/network involved.
export function mapTargetSignalsToTypes(targetSignals: string[]): SignalType[] {
  return targetSignals.map((s) => TARGET_SIGNAL_TO_TYPE[s]).filter((t): t is SignalType => !!t);
}

const MAX_AUTOMATIC_QUERIES = 12;

// Builds the automatic (non-explicit) query set from the full Partner
// Search Criteria profile as a bounded MIX of query shapes, never a hard
// implicit AND across every configured criterion (5B-R hotfix -- the prior
// version zipped technologies+partnerType+industries into one combined
// query per step, so a fully-configured profile could spend its entire
// budget on queries requiring all three at once, crowding out simpler,
// higher-recall shapes). Each "family" below is one bounded, independent
// query shape:
//   A. broad discovery      -- partner type + geography
//   B. ecosystem-focused    -- technology/ecosystem (+ partner type) + geography
//   C. industry-focused     -- industry (+ partner type) + geography
//   D. signal-focused       -- a configured target signal (+ partner type) + geography
// No family ever requires all of partner type + technology + industry +
// target signal + geography together. Families round-robin so no single
// shape can consume the whole budget before the others get a turn, and
// signals (D) are just one family among however many are present -- never
// a majority of the automatic query set on their own. Each family combines
// at most two configured dimensions plus geography (index-linked rotation,
// never a nested/cross-product loop), so there is no Cartesian explosion
// even with a rich profile. Deduplicated and capped at
// MAX_AUTOMATIC_QUERIES; returns [] only when nothing at all is configured.
export function buildAutomaticQueries(config: ScanConfig, territory: Territory): string[] {
  const industries = (config.industries as string[]) ?? [];
  const technologies = (config.technologies as string[]) ?? [];
  const countries = (territory.countries as string[]) ?? [];
  // Unknown/custom partner type strings pass through partnerTypeSearchVariants
  // literally (see its fallback below), so custom types keep showing up here.
  const partnerTypeTerms = ((config.partnerTypes as string[]) ?? []).flatMap(partnerTypeSearchVariants);
  const geoSuffix = (i: number) => (countries.length > 0 ? ` ${countries[i % countries.length]}` : "");
  const signalTerms = ((config.targetSignals as string[]) ?? []).map((s) => TARGET_SIGNAL_SEARCH_TERMS[s]).filter((t): t is string => !!t);
  const partnerTypeAt = (i: number) => (partnerTypeTerms.length > 0 ? partnerTypeTerms[i % partnerTypeTerms.length] : null);

  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const trimmed = q.trim();
    if (trimmed && !seen.has(trimmed) && queries.length < MAX_AUTOMATIC_QUERIES) {
      seen.add(trimmed);
      queries.push(trimmed);
    }
  };

  const families: Array<() => string> = [];

  // A. broad discovery: partner type + geography.
  if (partnerTypeTerms.length > 0) {
    let i = 0;
    families.push(() => `"${partnerTypeAt(i)}"${geoSuffix(i++)}`);
  }

  // B. ecosystem-focused: technology/ecosystem (+ partner type, if
  // configured) + geography. Never requires industry or a target signal.
  if (technologies.length > 0) {
    let i = 0;
    families.push(() => {
      const pt = partnerTypeAt(i);
      const q = `"${technologies[i % technologies.length]}"${pt ? ` "${pt}"` : ""}${geoSuffix(i)}`;
      i++;
      return q;
    });
  }

  // C. industry-focused: industry (+ partner type, if configured) +
  // geography. Never requires technology or a target signal.
  if (industries.length > 0) {
    let i = 0;
    families.push(() => {
      const pt = partnerTypeAt(i);
      const q = `${pt ? `"${pt}" ` : ""}${industries[i % industries.length]}${geoSuffix(i)}`;
      i++;
      return q;
    });
  }

  // D. signal-focused: a configured target signal (+ partner type, if
  // configured) + geography. One family among however many are present --
  // round-robin below keeps this from ever dominating the budget.
  if (signalTerms.length > 0) {
    let i = 0;
    families.push(() => {
      const pt = partnerTypeAt(i);
      const q = `"${signalTerms[i % signalTerms.length]}"${pt ? ` "${pt}"` : ""}${geoSuffix(i)}`;
      i++;
      return q;
    });
  }

  const MAX_ROUNDS = MAX_AUTOMATIC_QUERIES * 3;
  for (let round = 0; round < MAX_ROUNDS && queries.length < MAX_AUTOMATIC_QUERIES && families.length > 0; round++) {
    for (const family of families) {
      if (queries.length >= MAX_AUTOMATIC_QUERIES) break;
      push(family());
    }
  }

  return queries;
}

// Exported for testing -- confirms explicit search_queries fully override
// automatic planning, never merge with it.
export function buildSearchQueries(config: ScanConfig, territory: Territory): string[] {
  const explicit = (config.searchQueries as string[]) ?? [];
  return explicit.length > 0 ? explicit : buildAutomaticQueries(config, territory);
}

// The canonical Partner Search Criteria passed to live AI qualification --
// derived from the same ScanConfig/Territory used to build search queries,
// so search and AI can never see two different profiles. territoryCountries
// comes directly from territories.countries (the canonical geography
// source), never resolveCountries()'s legacy fallback map: that fallback
// exists only for the demo generator below, and using it here would let
// Settings show no configured countries while the AI is silently told a
// hardcoded list.
export function buildPartnerSearchCriteria(config: ScanConfig, territory: Territory): aiProvider.PartnerSearchCriteria {
  return {
    partnerTypes: (config.partnerTypes as string[]) ?? [],
    industries: (config.industries as string[]) ?? [],
    technologies: (config.technologies as string[]) ?? [],
    territoryName: territory.name,
    territoryCountries: (territory.countries as string[]) ?? [],
    excludedDomains: (config.excludedDomains as string[]) ?? [],
    minChecksRequired: config.minChecksRequired,
    searchIntent: buildSearchQueries(config, territory),
    targetSignalTypes: mapTargetSignalsToTypes((config.targetSignals as string[]) ?? []),
  };
}

// Only web_search + ai are required live: extraction never makes its own
// call (see discoveryProviders/extraction.ts) so a web_reader connection
// has nothing to credential and would only ever block live discovery.
const REQUIRED_PROVIDER_TYPES = ["web_search", "ai"] as const;

// Phase 11.6.1 P3A: optional, additive context about the ORIGINAL evidence
// that produced subjectCompanyName -- purely to help the AI confirmation
// step (identifyCompanyViaDeepSeek) disambiguate two real companies that
// happen to share a name (e.g. "Apex Consulting" operating independently in
// two different countries). Never used to invent a domain; the search/
// candidate-only rules are unchanged. A call site that omits this
// (`resolveCompanyIdentity(name)`, the pre-P3A call shape) behaves
// byte-identically to before this phase.
export interface CompanyIdentityContext {
  evidenceUrl?: string;
  evidenceSnippet?: string;
  territoryCountries?: string[];
}

// Only called for third-party evidence about a candidate that already
// passed qualification (see the cost-control gate in attemptLiveDiscovery
// below), OR (Phase 11.6.1 P3A) for a bounded, ranked subset of
// pre-qualification subjects needing contextual domain resolution (see
// resolveCandidateIdentities below) -- same function, same guarantees,
// either caller. Never invents a domain: DeepSeek is only ever shown the
// Tavily results below and must say "unresolved" rather than recall a
// domain from its own general knowledge. Any failure (search or AI call) is
// treated the same as "could not resolve" -- logged and skipped, never
// allowed to fail the whole scan over one candidate's identity lookup.
async function resolveCompanyIdentity(
  subjectCompanyName: string,
  context?: CompanyIdentityContext,
): Promise<{ name: string; domain: string } | null> {
  try {
    const results = await searchProvider.search(`"${subjectCompanyName}" official website`, { maxResults: 3 });
    if (results.length === 0) return null;
    return await aiProvider.identifyCompany({
      subjectCompanyName,
      candidates: results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet })),
      evidenceUrl: context?.evidenceUrl,
      evidenceSnippet: context?.evidenceSnippet,
      territoryCountries: context?.territoryCountries,
    });
  } catch (err) {
    logger.warn(
      { subjectCompanyName, errorName: err instanceof Error ? err.name : typeof err },
      "Discovery: company identity resolution call failed; candidate skipped",
    );
    return null;
  }
}

// Pure decision logic, exported for testing without a live search/AI call
// or a DB connection: given a qualification's identity fields and the
// evidence's own domain, decides the prospective-partner identity to
// persist, or null if it can't/shouldn't be. `resolveIdentity` is injected
// (defaults to the real resolveCompanyIdentity above) so tests can supply
// canned results for the first-party / third-party-resolved /
// third-party-unresolved cases.
//
// Phase 3A: the returned companyDomain is always the canonical registrable
// domain (never a raw hostname/subdomain/URL) -- both branches below run
// through toRegistrableDomain, so "ir.uipath.com" and a third-party
// identity-resolution result of "https://www.uipath.com" both collapse to
// "uipath.com" before this function ever returns. This is the one place
// evidence identity (evidenceDomain, still used verbatim for
// signals.sourceDomain by the caller) and company identity (the returned
// companyDomain) diverge on purpose.
//
// Defense-in-depth: even when the AI qualification step marks evidence
// sourceIsFirstParty=true, evidence hosted on a known non-corporate/platform
// domain (LinkedIn, YouTube, generic job boards, ...) is never trusted as
// company identity -- it's forced through the same third-party
// identity-resolution path as any other publisher, exactly as if the model
// had classified it correctly. The evidence itself is never discarded for
// living on such a domain; only its eligibility to name the company is
// overridden.
export async function resolveCandidateCompanyIdentity(
  qualification: Pick<aiProvider.AiQualificationOutput, "sourceIsFirstParty" | "subjectCompanyName">,
  evidenceDomain: string,
  resolveIdentity: (subjectCompanyName: string) => Promise<{ name: string; domain: string } | null> = resolveCompanyIdentity,
): Promise<{ companyName: string; companyDomain: string } | null> {
  const evidenceRegistrableDomain = toRegistrableDomain(evidenceDomain);
  const isEligibleFirstParty = qualification.sourceIsFirstParty && !isKnownNonCorporateDomain(evidenceRegistrableDomain);

  if (isEligibleFirstParty) {
    if (!evidenceRegistrableDomain) return null; // evidence domain itself isn't a safe, resolvable identity
    return { companyName: qualification.subjectCompanyName, companyDomain: evidenceRegistrableDomain };
  }
  const resolved = await resolveIdentity(qualification.subjectCompanyName);
  if (!resolved) return null;
  const resolvedRegistrableDomain = toRegistrableDomain(resolved.domain);
  if (!resolvedRegistrableDomain) return null; // resolved identity's domain string wasn't safely parseable either
  // Same defense-in-depth guard as the first-party fast path above, applied
  // here too: the third-party identity search hands DeepSeek raw web-search
  // results to interpret, which is exactly the path most likely to mistake a
  // social/video/job-board URL for "the official site" -- a resolved domain
  // is never trusted as company identity just because it came from this
  // branch instead of the evidence-domain branch.
  if (isKnownNonCorporateDomain(resolvedRegistrableDomain)) return null;
  return { companyName: resolved.name, companyDomain: resolvedRegistrableDomain };
}

// ---- Phase 11.6.1 P3A: company-level candidate pipeline -------------------
//
// Root cause (Phase 11.6.1 P3A forensic audit): MAX_CANDIDATES_TO_LLM
// previously applied to raw search-result URLs in encounter order, with no
// company-level grouping, ranking, or evidence aggregation -- so several
// URLs about the same real company (its own site, a wire-service article, a
// partner-directory listing) could each independently consume a
// qualification slot, crowding out genuinely distinct companies, and each
// qualification call ever saw exactly one fragment of evidence. This
// section turns a pool of eligible search results into a bounded, ranked
// set of DISTINCT CANDIDATE ENTRIES before any qualification slot is spent.
// qualifyChecks, MAX_CANDIDATES_TO_LLM, and every persistence rule below are
// completely untouched by this section.
//
// HARD CORRECTNESS RULE (do not weaken): subjectCompanyName is NEVER a
// grouping key, a cache key, or a dedupe key. It is only ever (a) input to
// a domain-resolution request, or (b) display/context. Two evidence items
// may join one candidate group ONLY after EACH has independently, safely
// established the SAME canonical registrable domain -- never because their
// extracted names matched (two different real companies can share a name,
// e.g. two unrelated "Apex Consulting" businesses in different countries --
// see groupAnnotatedResults below, and the Phase 11.6.1 P3A design report's
// Case E).

// Bounded batch size for subject-extraction calls -- balances fewer calls
// (larger batches) against a comfortably small, boundable per-call payload/
// output (see aiProvider's SUBJECT_EXTRACTION_MAX_TOKENS). Runs over the
// whole eligible pool, which is typically larger than the 20-slot
// qualification budget itself.
export const SUBJECT_EXTRACTION_BATCH_SIZE = 10;

// Conservative initial cap on contextual external domain-resolution calls
// (1 Tavily search + 1 DeepSeek identify per attempt) per run. Chosen
// deliberately small relative to a typical eligible-result pool (the
// audited production example surfaced ~66 results): bounds worst-case added
// cost to a fixed, small number of extra call-pairs regardless of how many
// distinct unresolved subjects a run turns up, while still large enough to
// meaningfully improve grouping over the prior "1 candidate = 1 raw URL"
// behavior. Raising this should be justified by measured production yield
// data, not guessed -- see the Phase 11.6.1 P3A design report's cost model.
export const CONTEXTUAL_RESOLUTION_MAX_K = 10;

export const MAX_EVIDENCE_ITEMS_PER_CANDIDATE = 3;

export interface EligibleResult {
  resultId: string;
  url: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
  score: number;
  evidenceDomain: string;
  text: string;
}

export interface AnnotatedResult extends EligibleResult {
  subjectCompanyName: string | null;
  sourceIsFirstParty: boolean;
  identityStatus: aiProvider.SubjectIdentityStatus;
  // Set only once a canonical domain has been independently, safely
  // established for THIS item (the free first-party fast path, or a
  // successful bounded contextual resolution) -- null otherwise. Never set
  // from subjectCompanyName alone.
  canonicalDomain: string | null;
}

export interface ResolvedGroupEntry {
  kind: "group";
  canonicalDomain: string;
  items: AnnotatedResult[];
}

export interface StandaloneEntry {
  kind: "standalone";
  item: AnnotatedResult;
}

export type CandidateEntry = ResolvedGroupEntry | StandaloneEntry;

// Pure. Splits a flat list into fixed-size batches, preserving order.
export function chunkIntoBatches<T>(items: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

// Pure. The ONLY place a domain is trusted "for free" without an external
// resolution call: an item the subject-extraction stage marked
// source_is_first_party=true AND identity_status="resolved" AND whose OWN
// evidence domain is a safe, non-known-non-corporate registrable domain --
// exactly the same defense-in-depth guard resolveCandidateCompanyIdentity's
// first-party fast path already applies post-qualification, applied here
// pre-qualification instead. Never trusts subjectCompanyName itself as a
// domain source.
export function freeFirstPartyDomain(result: AnnotatedResult): string | null {
  if (!result.sourceIsFirstParty || result.identityStatus !== "resolved" || !result.subjectCompanyName) return null;
  const registrable = toRegistrableDomain(result.evidenceDomain);
  if (!registrable || isKnownNonCorporateDomain(registrable)) return null;
  return registrable;
}

// Pure. Deterministic selection order for which still-unresolved items
// receive a bounded, costly external resolution call -- Tavily's own
// relevance score, with a stable encounter-order tiebreak (resultId is
// assigned in encounter order -- see attemptLiveDiscovery). Never a
// semantic judgment.
function rankForContextualResolution(items: readonly AnnotatedResult[]): AnnotatedResult[] {
  return [...items].sort((a, b) => b.score - a.score || Number(a.resultId) - Number(b.resultId));
}

export interface IdentityResolutionSummary {
  eligibleCount: number;
  subjectExtractionResolved: number;
  subjectExtractionUnknown: number;
  subjectExtractionAmbiguous: number;
  freeFirstPartyResolutions: number;
  contextualResolutionAttempted: number;
  contextualResolutionSucceeded: number;
  contextualResolutionFailed: number;
}

// Orchestrates the full pre-qualification identity stage: batched subject
// extraction -> free first-party domains -> bounded (CONTEXTUAL_RESOLUTION_
// MAX_K) contextual resolution for the highest-ranked remainder -> anything
// else stays unresolved/standalone. Returns every eligible result annotated
// (never grouped -- see groupAnnotatedResults) plus structured counts for
// observability (Phase 11.6.1 P3A section 10 -- logged/tested, never a new
// scan_runs column).
export async function resolveCandidateIdentities(
  eligibleResults: readonly EligibleResult[],
  territoryCountries: string[],
  resolveIdentityWithContext: (
    subjectCompanyName: string,
    context: CompanyIdentityContext,
  ) => Promise<{ name: string; domain: string } | null> = resolveCompanyIdentity,
  // Injected (defaults to the real aiProvider.extractSubjects) so tests can
  // supply canned batch results without a live AI call or a DB-backed
  // isConfigured() credential check -- same convention as
  // resolveCandidateCompanyIdentity's injected resolveIdentity parameter.
  extractSubjectsFn: (input: aiProvider.SubjectExtractionBatchInput) => Promise<aiProvider.SubjectExtractionResult[]> = aiProvider.extractSubjects,
): Promise<{ results: AnnotatedResult[]; summary: IdentityResolutionSummary }> {
  const batches = chunkIntoBatches(eligibleResults, SUBJECT_EXTRACTION_BATCH_SIZE);
  const extractionByResultId = new Map<string, aiProvider.SubjectExtractionResult>();

  for (const batch of batches) {
    if (batch.length === 0) continue;
    try {
      const extracted = await extractSubjectsFn({
        candidates: batch.map((r) => ({ resultId: r.resultId, title: r.title, url: r.url, snippet: r.snippet.slice(0, 500) })),
        territoryCountries,
      });
      for (const r of extracted) extractionByResultId.set(r.resultId, r);
    } catch (err) {
      // Deliberately different severity from a qualification-call failure:
      // losing one batch's subject extraction only means those items fall
      // back to standalone processing (exactly today's original per-URL
      // behavior for that item) -- it never means the scan can't evaluate
      // ANY candidates, so it must never abort the run the way a
      // provider-wide qualification failure does.
      logger.warn(
        { batchSize: batch.length, errorName: err instanceof Error ? err.name : typeof err },
        "Discovery: subject-extraction batch failed; items in this batch fall back to standalone processing",
      );
    }
  }

  let subjectExtractionResolved = 0;
  let subjectExtractionUnknown = 0;
  let subjectExtractionAmbiguous = 0;
  let freeFirstPartyResolutions = 0;

  const annotated: AnnotatedResult[] = eligibleResults.map((r) => {
    const extracted = extractionByResultId.get(r.resultId);
    const identityStatus: aiProvider.SubjectIdentityStatus = extracted?.identityStatus ?? "unknown";
    if (identityStatus === "resolved") subjectExtractionResolved++;
    else if (identityStatus === "ambiguous") subjectExtractionAmbiguous++;
    else subjectExtractionUnknown++;

    return {
      ...r,
      subjectCompanyName: extracted?.subjectCompanyName ?? null,
      sourceIsFirstParty: extracted?.sourceIsFirstParty ?? false,
      identityStatus,
      canonicalDomain: null,
    };
  });

  for (const result of annotated) {
    const free = freeFirstPartyDomain(result);
    if (free) {
      result.canonicalDomain = free;
      freeFirstPartyResolutions++;
    }
  }

  const stillUnresolved = annotated.filter(
    (r) => r.canonicalDomain === null && r.identityStatus === "resolved" && r.subjectCompanyName,
  );
  const toResolve = rankForContextualResolution(stillUnresolved).slice(0, CONTEXTUAL_RESOLUTION_MAX_K);

  let contextualResolutionSucceeded = 0;
  let contextualResolutionFailed = 0;

  for (const result of toResolve) {
    const resolved = await resolveIdentityWithContext(result.subjectCompanyName!, {
      evidenceUrl: result.url,
      evidenceSnippet: result.snippet.slice(0, 600),
      territoryCountries,
    });
    if (!resolved) {
      contextualResolutionFailed++;
      continue;
    }
    const registrable = toRegistrableDomain(resolved.domain);
    if (!registrable || isKnownNonCorporateDomain(registrable)) {
      contextualResolutionFailed++;
      continue;
    }
    result.canonicalDomain = registrable;
    contextualResolutionSucceeded++;
  }

  return {
    results: annotated,
    summary: {
      eligibleCount: eligibleResults.length,
      subjectExtractionResolved,
      subjectExtractionUnknown,
      subjectExtractionAmbiguous,
      freeFirstPartyResolutions,
      contextualResolutionAttempted: toResolve.length,
      contextualResolutionSucceeded,
      contextualResolutionFailed,
    },
  };
}

// Pure. Groups ONLY by an already-established canonical domain
// (AnnotatedResult.canonicalDomain) -- never by subjectCompanyName, never
// by evidenceDomain/publisher domain. Everything without a canonical domain
// becomes its own standalone entry, in original encounter order, never
// discarded.
export function groupAnnotatedResults(results: readonly AnnotatedResult[]): CandidateEntry[] {
  const groups = new Map<string, AnnotatedResult[]>();
  const standalone: AnnotatedResult[] = [];

  for (const result of results) {
    if (result.canonicalDomain) {
      const existing = groups.get(result.canonicalDomain);
      if (existing) existing.push(result);
      else groups.set(result.canonicalDomain, [result]);
    } else {
      standalone.push(result);
    }
  }

  const entries: CandidateEntry[] = [];
  for (const [canonicalDomain, items] of groups) {
    entries.push({ kind: "group", canonicalDomain, items });
  }
  for (const item of standalone) {
    entries.push({ kind: "standalone", item });
  }
  return entries;
}

// Pure, deterministic, non-semantic ranking of the final candidate entries
// (groups + standalone, mixed) -- decides which up to MAX_CANDIDATES_TO_LLM
// entries are worth an expensive qualification call. Never predicts
// partner fit; only how well-supported/distinct a candidate looks from
// already-known, non-semantic signals: (1) first-party evidence present
// anywhere in the entry, (2) number of evidence items (more independent
// corroboration), (3) the entry's strongest Tavily relevance score, (4) a
// stable tiebreak by earliest encounter order.
function candidateEntryRankKey(entry: CandidateEntry): { hasFirstParty: boolean; itemCount: number; maxScore: number; earliestResultId: number } {
  const items = entry.kind === "group" ? entry.items : [entry.item];
  return {
    hasFirstParty: items.some((i) => i.sourceIsFirstParty),
    itemCount: items.length,
    maxScore: Math.max(...items.map((i) => i.score)),
    earliestResultId: Math.min(...items.map((i) => Number(i.resultId))),
  };
}

export function rankCandidateEntries(entries: readonly CandidateEntry[]): CandidateEntry[] {
  return [...entries].sort((a, b) => {
    const ka = candidateEntryRankKey(a);
    const kb = candidateEntryRankKey(b);
    if (ka.hasFirstParty !== kb.hasFirstParty) return ka.hasFirstParty ? -1 : 1;
    if (ka.itemCount !== kb.itemCount) return kb.itemCount - ka.itemCount;
    if (ka.maxScore !== kb.maxScore) return kb.maxScore - ka.maxScore;
    return ka.earliestResultId - kb.earliestResultId;
  });
}

export interface FreshnessFilterResult {
  freshEntries: CandidateEntry[];
  skippedRecentCount: number;
}

// Pure. Recall fix (novelty prioritization): filters RANKED candidate
// entries down to ones not already evaluated recently (qualified OR
// rejected -- see discoveryEvaluations.ts), preserving relative order --
// this is a single forward filtering pass over `entries`, nothing is
// re-sorted, so ranking order among the remaining entries is unchanged.
// Meant to run AFTER rankCandidateEntries and BEFORE the
// MAX_CANDIDATES_TO_LLM slice (see attemptLiveDiscovery's Stage 3) -- so the
// qualification budget is spent on the best-ranked NOVEL candidates first,
// never burned on re-litigating an already-known company ahead of a
// genuinely unseen one.
//
// Only a GROUP entry (already has an established canonical domain -- see
// groupAnnotatedResults) can be checked; a standalone entry has no domain
// pre-qualification by construction, so checking it here would require an
// extra identity-resolution call, defeating the cost-control purpose of
// this filter -- it always passes through unfiltered, exactly as before
// this fix existed.
export function filterRecentlyEvaluatedEntries(
  entries: readonly CandidateEntry[],
  knownDomainRecords: ReadonlyMap<string, ExistingQualificationRecord | null>,
  recencyWindowDays: number,
): FreshnessFilterResult {
  const freshEntries: CandidateEntry[] = [];
  let skippedRecentCount = 0;
  for (const entry of entries) {
    if (entry.kind === "group" && shouldReuseExistingQualification(knownDomainRecords.get(entry.canonicalDomain) ?? null, recencyWindowDays)) {
      skippedRecentCount++;
      continue;
    }
    freshEntries.push(entry);
  }
  return { freshEntries, skippedRecentCount };
}

// Pure. Selects at most maxItems evidence items for one qualification call:
// (1) the strongest first-party item if any, then (2)-(3) the strongest
// items from DISTINCT source domains not already represented -- never
// blindly the top-N by score alone, which could select several
// near-duplicate pages from the same domain instead of genuinely
// corroborating, diverse evidence. Only once true source diversity is
// exhausted does it fill any remaining slots with the next-best real items
// regardless of domain repeat -- it never pads with fabricated content, and
// a candidate with fewer than maxItems items overall simply returns fewer.
export function selectEvidenceItems(
  items: readonly AnnotatedResult[],
  maxItems: number = MAX_EVIDENCE_ITEMS_PER_CANDIDATE,
): AnnotatedResult[] {
  const selected: AnnotatedResult[] = [];
  const usedDomains = new Set<string>();

  const firstParty = [...items].filter((i) => i.sourceIsFirstParty).sort((a, b) => b.score - a.score)[0];
  if (firstParty) {
    selected.push(firstParty);
    usedDomains.add(firstParty.evidenceDomain);
  }

  const remainingByScore = [...items].filter((i) => i !== firstParty).sort((a, b) => b.score - a.score);

  for (const item of remainingByScore) {
    if (selected.length >= maxItems) break;
    if (usedDomains.has(item.evidenceDomain)) continue;
    selected.push(item);
    usedDomains.add(item.evidenceDomain);
  }

  if (selected.length < maxItems) {
    for (const item of remainingByScore) {
      if (selected.length >= maxItems) break;
      if (selected.includes(item)) continue;
      selected.push(item);
    }
  }

  return selected.slice(0, maxItems);
}

export interface LiveDiscoveryStats {
  queriesRun: number;
  uniqueCompaniesSeen: number;
  newCompaniesCount: number;
  duplicatesRemoved: number;
  candidatesSentToLlm: number;
  candidatesQualified: number;
  // Recall fix (novelty prioritization): candidate ENTRIES excluded from
  // this run's MAX_CANDIDATES_TO_LLM slots because their canonical domain
  // was already evaluated recently -- see discovery_evaluations.ts.
  // Distinct from candidatesSentToLlm, which only ever counts actual
  // qualification calls (see the Important note in Stage 3 above).
  candidatesSkippedRecent: number;
  // Product decision (hotfix): a candidate that fully clears qualification
  // AND identity resolution is persisted immediately, not batched until the
  // whole run succeeds -- so this is the true "how many new prospects did
  // this run actually create" count, meaningful even on a run that later
  // fails. See the persistence loop below and runDiscoveryForConfig's use
  // of it as qualifiedCount on the live path.
  prospectsCreated: number;
  stoppedReason: BudgetStopReason;
}

export interface LiveDiscoveryResult {
  candidates: Candidate[];
  stats: LiveDiscoveryStats;
}

// Production hotfix: progress checkpoints written *while the scan is still
// running*, not just once at the very end. Each call is a single tiny
// single-row UPDATE by primary key -- bounded by the same hard caps already
// enforced (at most MAX_QUERIES_PER_RUN query checkpoints + at most
// MAX_CANDIDATES_TO_LLM*2 qualification checkpoints per run, never one per
// search result), so this is a small, fixed number of extra writes, not
// unbounded chatter. This is also what makes partial progress survive a
// mid-run exception: by the time an error propagates out of
// attemptLiveDiscovery, every counter up to the last completed checkpoint
// is already durable in scan_runs, independent of whether the function
// itself ever returns normally.
async function writeScanRunProgress(
  runId: string,
  patch: Partial<
    Pick<
      LiveDiscoveryStats,
      "queriesRun" | "uniqueCompaniesSeen" | "newCompaniesCount" | "duplicatesRemoved" | "candidatesSentToLlm" | "candidatesQualified" | "candidatesSkippedRecent"
    >
  >,
): Promise<void> {
  await db.update(scanRunsTable).set(patch).where(eq(scanRunsTable.id, runId));
}

// Exported for testing -- pure pre-qualification dedupe decision, no DB or
// network. 5B-R hotfix: only a literal repeated URL is ever a skip reason
// here. A repeated evidence *domain* is deliberately never sufficient on
// its own -- see the seenUrls comment in attemptLiveDiscovery below for why
// (third-party publisher domains legitimately carry evidence about many
// different companies).
export function shouldSkipBeforeQualification(seenUrls: ReadonlySet<string>, url: string): boolean {
  return seenUrls.has(url);
}

// Exported for testing. 5B-R hotfix: classifies which AiProviderError codes
// are candidate-level (this one piece of evidence produced an unusable AI
// response -- log it, skip only this candidate, keep scanning the rest)
// versus scan-level (the provider itself is unavailable/misbehaving -- still
// fails the whole run). A single malformed/empty/truncated/schema-invalid
// response is a property of one AI call's output, not evidence the provider
// is down. timeout/network_error/http_error/oversized_response remain
// scan-level/fatal, same as classifyDiscoveryFailure already reports them --
// a real provider outage or rate limit must never be silently swallowed.
export const CANDIDATE_LEVEL_AI_ERROR_CODES: ReadonlySet<string> = new Set([
  "malformed_json",
  "empty_response",
  "truncated",
  "schema_invalid",
]);

// Phase 11.6.1 P3A: injectable provider dependencies -- every field optional
// and defaulting to the real provider module, so the existing production
// call site (runDiscoveryForConfig's `attemptLiveDiscovery(config,
// territory, run!.id)`, no 4th argument) is completely unaffected. Exists
// solely so an integration test can exercise this function's REAL,
// unmodified control flow (grouping/ranking/evidence-aggregation) against a
// real database without a live Tavily/DeepSeek credential or network call --
// same "inject the provider call, default to the real one" convention
// already used by resolveCandidateCompanyIdentity's resolveIdentity
// parameter and resolveCandidateIdentities' own two injected parameters.
// extractionProvider.extract is deliberately NOT made injectable here: it
// is already pure/local (bounds already-supplied text, no network/DB call
// of its own -- see discoveryProviders/extraction.ts), so the real
// implementation is safe to use directly in any test.
export interface LiveDiscoveryDeps {
  searchFn?: (query: string, opts: { maxResults: number; startDate?: string }) => Promise<searchProvider.WebSearchResult[]>;
  qualifyFn?: (input: aiProvider.AiQualificationInput) => Promise<aiProvider.AiQualificationOutput>;
  resolveIdentityWithContext?: (
    subjectCompanyName: string,
    context: CompanyIdentityContext,
  ) => Promise<{ name: string; domain: string } | null>;
  extractSubjectsFn?: (input: aiProvider.SubjectExtractionBatchInput) => Promise<aiProvider.SubjectExtractionResult[]>;
}

// Stage 6.5 Cost-Aware Adaptive Discovery: bounded initial batch -> evaluate
// new-candidate yield -> optional bounded expansion -> stop on a hard cap or
// sustained poor yield (see discoveryBudget.ts's decideNextBatch). Territory
// size affects how much of the existing MAX_QUERIES_PER_RUN/
// MAX_CANDIDATES_TO_LLM ceiling a run actually uses -- it never raises the
// ceiling itself, and it never changes qualifyChecks' qualification bar.
export async function attemptLiveDiscovery(
  config: ScanConfig,
  territory: Territory,
  runId: string,
  deps: LiveDiscoveryDeps = {},
): Promise<LiveDiscoveryResult | null> {
  const search = deps.searchFn ?? searchProvider.search;
  const qualify = deps.qualifyFn ?? aiProvider.qualify;

  const rows = await db.select().from(connectionsTable).where(inArray(connectionsTable.providerType, REQUIRED_PROVIDER_TYPES));
  const byType = new Map(rows.map((r) => [r.providerType, r]));
  const ready = REQUIRED_PROVIDER_TYPES.every((t) => hasCredential(byType.get(t)?.credentialEnvVar ?? null));
  if (!ready) return null;

  try {
    // Computed once and iterated directly (criteria.searchIntent), not via
    // a second buildSearchQueries call -- search and AI qualification below
    // literally share the same array, not just equal-by-construction copies.
    const criteria = buildPartnerSearchCriteria(config, territory);
    // Same excluded-domains gate runDiscoveryForConfig's own loop has always
    // applied for the demo path -- reused verbatim (not reimplemented) so a
    // live candidate is excluded at exactly the same logical point it always
    // was: after qualification, before persistence, never affecting whether
    // it's counted toward resultsFound (candidates.length) below.
    const excludedDomains = (config.excludedDomains as string[]) ?? [];
    // Phase 11.5A: PAM-created "don't suggest this company again" exclusions
    // -- a separate, deterministic guard from config.excludedDomains above
    // (admin-maintained free-text list), loaded once per run, same
    // territory scope. Checked twice below: as early as the evidence
    // domain is known (before the extraction/subject-extraction cost), and
    // again at the same point excludedDomains is checked (using the
    // resolved canonical domain, since evidence can legitimately come from
    // a third-party source whose own domain was never excluded).
    const discoveryExclusionDomains = await loadActiveExclusionDomains(territory.id);
    const territoryCountries = (territory.countries as string[]) ?? [];
    // Phase 11.5C.3: trusted DRUID context, loaded and formatted once per
    // run (same tier as criteria/discoveryExclusionDomains above) and
    // passed to every qualification call below -- never a per-candidate DB
    // query. Optional grounding, not a correctness/safety gate like
    // discoveryExclusionDomains: a load failure must never abort the run,
    // so it degrades to "" (identical to the zero-trusted-facts case) and
    // is only logged, matching this function's existing candidate-level
    // "one non-essential AI/data failure must never fail the whole scan"
    // convention (see the CANDIDATE_LEVEL_AI_ERROR_CODES handling below).
    // Never invents DRUID knowledge on failure -- "" simply means no DRUID
    // context is added to the prompt, exactly like having zero verified
    // facts.
    let druidContext = "";
    try {
      druidContext = formatTrustedDruidContext(await listTrustedDruidFacts());
    } catch (err) {
      logger.warn(
        { scanConfigId: config.id, errorName: err instanceof Error ? err.name : typeof err },
        "Discovery: failed to load trusted DRUID context for this run; continuing without DRUID grounding",
      );
    }
    const candidates: Candidate[] = [];
    // Cross-query dedup: the same URL can legitimately surface from more
    // than one query variant (see buildAutomaticQueries) -- only collect it
    // once. This is deliberately the *only* dedupe keyed on the result
    // itself at this stage (5B-R hotfix -- a prior version also dropped any
    // later result whose evidence *domain* repeated, e.g. a second
    // reuters.com URL, on the assumption a repeated domain meant a repeated
    // company. That's false for third-party sources: wire services, PR
    // distributors, and analyst sites legitimately carry evidence about
    // many different companies. Phase 11.6.1 P3A: the real subject company
    // is now determined by subject extraction + contextual domain
    // resolution below, and company-level grouping happens explicitly by
    // canonical domain -- never by evidence domain, never by name -- see
    // resolveCandidateIdentities/groupAnnotatedResults.)
    const seenUrls = new Set<string>();

    // Cost control B (evaluation cache): one query for every already-known
    // company's domain + its most recent prospect's freshness fields.
    // shouldReuseExistingQualification (config.recencyWindowDays -- the
    // same freshness window Discovery/Prospects already use, not a second
    // invented one) decides whether a known company is skipped outright
    // (fresh) or re-qualified (stale / never actually qualified before).
    const existingRows = await db
      .select({ domain: companiesTable.domain, lastResearchedAt: prospectsTable.lastResearchedAt, createdAt: prospectsTable.createdAt })
      .from(companiesTable)
      .leftJoin(prospectsTable, eq(prospectsTable.companyId, companiesTable.id));
    const knownDomainRecords = new Map<string, ExistingQualificationRecord | null>();
    for (const row of existingRows) {
      if (!row.domain) continue;
      const record: ExistingQualificationRecord | null = row.createdAt ? { lastResearchedAt: row.lastResearchedAt, createdAt: row.createdAt } : null;
      const existing = knownDomainRecords.get(row.domain);
      if (!existing || (record && (!existing.lastResearchedAt || (record.lastResearchedAt ?? record.createdAt) > (existing.lastResearchedAt ?? existing.createdAt)))) {
        knownDomainRecords.set(row.domain, record);
      }
    }
    // Recall fix (novelty prioritization): also honor recorded evaluation
    // outcomes (discovery_evaluations) -- the ONLY durable record of a
    // REJECTED candidate. Before this, a company that failed qualifyChecks
    // (or was archetype-ineligible) had no representation here at all, so a
    // fresh scan re-spent a full AI qualification call on it every run,
    // regardless of how recently it had already been evaluated. Merged into
    // the SAME map/freshness rule as the companies/prospects join above --
    // "most recent wins" per domain -- so both Stage 1's existing per-result
    // check below and Stage 3's new per-candidate-entry check further down
    // benefit from one consistent freshness source, not two competing ones.
    // Every domain recorded into discovery_evaluations was already vetted as
    // a genuine, non-third-party company domain before being recorded (see
    // the Stage 4 loop below) -- so merging it here never reintroduces the
    // evidence-domain-collision risk the 5B-R hotfix guards against.
    for (const [domain, record] of await loadRecentEvaluationRecords()) {
      const existing = knownDomainRecords.get(domain);
      if (!existing || (record.lastResearchedAt ?? record.createdAt) > (existing.lastResearchedAt ?? existing.createdAt)) {
        knownDomainRecords.set(domain, record);
      }
    }

    let queriesRun = 0;
    let candidatesSentToLlm = 0;
    let candidatesQualified = 0;
    let candidatesSkippedRecent = 0;
    let duplicatesRemoved = 0;
    let uniqueCompaniesSeen = 0;
    let newCompaniesCount = 0;
    let prospectsCreated = 0;
    let stoppedReason: BudgetStopReason = "completed";
    const recentYields: number[] = [];

    // ---- Stage 1: adaptive search collection (unchanged logic/counters) ---
    // Exactly today's existing URL dedupe, excluded-domain filtering,
    // freshness-cache filtering, and adaptive query-batch budget
    // (decideNextBatch/MAX_QUERIES_PER_RUN/MAX_BATCHES_PER_RUN/saturation --
    // all untouched, discoveryBudget.ts). The only change from before Phase
    // 11.6.1 P3A: a surviving result is collected into eligibleResults
    // instead of being immediately extracted and qualified in place.
    // MAX_CANDIDATES_TO_LLM no longer gates this collection loop at all --
    // it now gates candidate-ENTRY selection in Stage 3, after grouping and
    // ranking (see below) -- so candidatesSentToLlm is legitimately always
    // 0 throughout this stage (nothing has been qualified yet); the other
    // decideNextBatch stop conditions (query/batch caps, saturation) are
    // completely unaffected and still bound how large this pool can grow.
    const eligibleResults: EligibleResult[] = [];

    const allQueries = criteria.searchIntent;
    const queryBatches: string[][] = [];
    for (let i = 0; i < allQueries.length; i += QUERIES_PER_BATCH) {
      queryBatches.push(allQueries.slice(i, i + QUERIES_PER_BATCH));
    }

    for (let batchIndex = 0; batchIndex < queryBatches.length; batchIndex++) {
      const decision = decideNextBatch({ queriesRun, candidatesSentToLlm, batchesRun: batchIndex, recentYields });
      if (decision.action === "stop") {
        stoppedReason = decision.reason;
        break;
      }

      let batchRaw = 0;
      let batchUnique = 0;
      let batchNew = 0;

      for (const query of queryBatches[batchIndex]!) {
        queriesRun++;
        const results = await search(query, { maxResults: config.maxResults });
        for (const result of results) {
          batchRaw++;
          if (shouldSkipBeforeQualification(seenUrls, result.url)) {
            duplicatesRemoved++;
            continue;
          }
          seenUrls.add(result.url);
          batchUnique++;

          const evidenceDomain = extractDomain(result.url);

          // Phase 11.5A: earliest safe exclusion check -- before the
          // extraction/subject-extraction/qualification cost below. Matched
          // on the registrable domain, same normalization companies.domain
          // itself uses, so "www.example.com" and "app.example.com" both
          // match an exclusion for "example.com". This can only under-match,
          // never over-match: if this evidence is a third-party source
          // (e.g. a press-release wire) rather than the company's own site,
          // evidenceDomain won't equal the excluded company's domain here --
          // the second check below (after identity resolution, on the
          // actual resolved company domain) is what guarantees correctness
          // in that case; this one is purely a cost-saving fast path.
          if (isDomainExcluded(toRegistrableDomain(evidenceDomain) ?? evidenceDomain, discoveryExclusionDomains)) {
            continue;
          }

          const isKnownDomain = knownDomainRecords.has(evidenceDomain);
          if (isKnownDomain) {
            // Not counted in duplicatesRemoved -- that counter is reserved
            // for in-run redundant results (URL/domain repeats within this
            // run, see above); a first-occurrence-this-run domain that
            // happens to already be a known company is captured cleanly by
            // (uniqueCompaniesSeen - newCompaniesCount) instead, so the two
            // counters never overlap (see territoryPotentialService.ts's
            // rawResultsTotal = uniqueCompaniesSeen + duplicatesRemoved).
            const cached = knownDomainRecords.get(evidenceDomain)!;
            if (shouldReuseExistingQualification(cached, config.recencyWindowDays)) {
              continue; // cache hit -- never call DeepSeek for a freshly-evaluated known company
            }
            // stale or never actually qualified (e.g. a Portfolio-only
            // company) -- falls through to real (refresh) consideration
            // below, but is still not counted as a NEW company for yield.
          } else {
            newCompaniesCount++;
            batchNew++;
          }
          uniqueCompaniesSeen++;

          // Tavily's search result already carries usable content -- no
          // second external call. extract() only validates/bounds it, and
          // is cheap/local, so it now runs for every eligible result (Stage
          // 2's subject extraction needs the text too), not only the ones
          // that eventually get qualified.
          const page = await extractionProvider.extract(result.url, { text: result.snippet, publishedAt: result.publishedAt });

          eligibleResults.push({
            resultId: String(eligibleResults.length),
            url: result.url,
            title: result.title,
            snippet: result.snippet,
            publishedAt: page.publishedAt,
            score: result.score,
            evidenceDomain,
            text: page.text,
          });
        }

        // Checkpoint 1/2: after this query's results are fully searched and
        // deduped -- queriesRun, plus the dedupe counters as they stand so
        // far this run. One write per completed query, never per result.
        await writeScanRunProgress(runId, { queriesRun, uniqueCompaniesSeen, newCompaniesCount, duplicatesRemoved });
      }

      recentYields.push(computeNewCandidateYield({ rawResults: batchRaw, uniqueCompanies: batchUnique, newCompanies: batchNew }));
    }

    // ---- Stage 2: batched subject extraction + bounded contextual domain resolution ----
    // See resolveCandidateIdentities's own doc comment for the full
    // algorithm; this call is the entire pre-qualification identity stage.
    const { results: annotatedResults, summary: identitySummary } = await resolveCandidateIdentities(
      eligibleResults,
      territoryCountries,
      deps.resolveIdentityWithContext,
      deps.extractSubjectsFn,
    );
    logger.info(
      {
        scanConfigId: config.id,
        eligibleResults: identitySummary.eligibleCount,
        subjectExtractionResolved: identitySummary.subjectExtractionResolved,
        subjectExtractionUnknown: identitySummary.subjectExtractionUnknown,
        subjectExtractionAmbiguous: identitySummary.subjectExtractionAmbiguous,
        freeFirstPartyResolutions: identitySummary.freeFirstPartyResolutions,
        contextualResolutionAttempted: identitySummary.contextualResolutionAttempted,
        contextualResolutionSucceeded: identitySummary.contextualResolutionSucceeded,
        contextualResolutionFailed: identitySummary.contextualResolutionFailed,
      },
      "Discovery: pre-qualification identity resolution complete",
    );

    // ---- Stage 3: company-level grouping, ranking, top-N selection --------
    // MAX_CANDIDATES_TO_LLM is applied HERE -- to distinct candidate
    // ENTRIES (a canonical-domain group, or a standalone unresolved item),
    // never to raw URLs. This is the actual fix for the confirmed root
    // cause: previously, several URLs about the same real company could
    // each independently consume one of these 20 slots.
    const allEntries = groupAnnotatedResults(annotatedResults);
    const rankedEntries = rankCandidateEntries(allEntries);

    // Recall fix (novelty prioritization): skip a GROUP entry whose
    // canonical domain was already evaluated recently (qualified OR
    // rejected -- see the knownDomainRecords merge above) BEFORE spending
    // one of the MAX_CANDIDATES_TO_LLM slots on it -- see
    // filterRecentlyEvaluatedEntries's own doc comment for the full
    // rationale. Applied here, after ranking and before the slice, so the
    // qualification cap is spent on actually-novel candidates first.
    const { freshEntries, skippedRecentCount } = filterRecentlyEvaluatedEntries(rankedEntries, knownDomainRecords, config.recencyWindowDays);
    candidatesSkippedRecent = skippedRecentCount;
    if (candidatesSkippedRecent > 0) await writeScanRunProgress(runId, { candidatesSkippedRecent });

    const selectedEntries = freshEntries.slice(0, MAX_CANDIDATES_TO_LLM);
    const groupCount = allEntries.filter((e) => e.kind === "group").length;
    const standaloneCount = allEntries.filter((e) => e.kind === "standalone").length;
    logger.info(
      {
        scanConfigId: config.id,
        candidateGroupsFormed: groupCount,
        standaloneCandidates: standaloneCount,
        totalCandidateEntries: rankedEntries.length,
        candidatesSkippedRecent,
        selectedForQualification: selectedEntries.length,
        excludedByTop20Cap: Math.max(0, freshEntries.length - selectedEntries.length),
      },
      "Discovery: candidate entries formed, ranked, filtered for recent evaluations, and capped at MAX_CANDIDATES_TO_LLM",
    );

    // ---- Stage 4: existing qualification, now over ranked candidate entries ----
    for (const entry of selectedEntries) {
      // Grouped candidates get up to MAX_EVIDENCE_ITEMS_PER_CANDIDATE
      // diverse evidence items (see selectEvidenceItems); a standalone
      // candidate has exactly the one item it always had. Either way this
      // is the exact same aiProvider.qualify(evidence: Array<{url,text}>)
      // call as before -- only how many items are in the array changed.
      const evidenceItems = entry.kind === "group" ? selectEvidenceItems(entry.items) : [entry.item];
      const primary = evidenceItems[0]!;

      // Checkpoint 3: recorded as "sent" the moment the call is made,
      // before awaiting the result -- if qualify() itself throws (timeout,
      // network error, etc.), this candidate genuinely was sent, and that
      // fact is already durable.
      candidatesSentToLlm++;
      await writeScanRunProgress(runId, { candidatesSentToLlm });
      let qualification: aiProvider.AiQualificationOutput;
      try {
        qualification = await qualify({
          companyName: primary.title,
          domain: primary.evidenceDomain,
          evidence: evidenceItems.map((item) => ({ url: item.url, text: item.text })),
          criteria,
          druidContext,
        });
      } catch (err) {
        // 5B-R hotfix: a candidate-level unusable AI response (malformed/
        // empty/truncated/schema-invalid -- see CANDIDATE_LEVEL_AI_ERROR_CODES)
        // must never fail the whole scan over one candidate. Only the
        // bounded, non-sensitive error code is logged, never a raw provider
        // message/body. Provider-wide failures (timeout, network_error,
        // http_error, oversized_response, or anything not an
        // AiProviderError at all) fall through to the rethrow below,
        // preserving the existing scan-abort + classifyDiscoveryFailure
        // behavior for genuine outages/auth/rate-limit conditions.
        if (err instanceof aiProvider.AiProviderError && CANDIDATE_LEVEL_AI_ERROR_CODES.has(err.code)) {
          logger.warn(
            { scanConfigId: config.id, evidenceUrl: primary.url, code: err.code },
            "Discovery: AI qualification returned an unusable response for this candidate; skipped, scan continuing",
          );
          continue;
        }
        throw err;
      }

      const checks: FiveChecks = {
        enterpriseAccess: qualification.enterpriseAccess,
        relevantCapability: qualification.relevantCapability,
        technologyAdjacency: qualification.technologyAdjacency,
        partnershipOpenness: qualification.partnershipOpenness,
        recentTrigger: qualification.recentTrigger,
      };

      // Same qualification bar regardless of territory -- qualifyChecks and
      // config.minChecksRequired are completely untouched by Phase 11.6.1
      // P3A. Result is kept (not just null-checked) -- it's the exact
      // QualificationResult persistCandidate needs below, never recomputed.
      const qualificationResult = qualifyChecks(checks, config.minChecksRequired);

      // Phase 11.6.1 P3A (section 9): a candidate that already entered
      // qualification with an independently-established canonical domain
      // (entry.kind === "group") reuses that identity directly -- it never
      // runs a second, potentially-contradictory post-qualification
      // identity-resolution pass over the same evidence. That domain was
      // already run through toRegistrableDomain + isKnownNonCorporateDomain
      // when it was first established (freeFirstPartyDomain, or the
      // contextual-resolution branch in resolveCandidateIdentities above),
      // so this is not a weakening of the P0 non-corporate-domain
      // protection -- only avoiding a redundant, contradictory second
      // check on evidence already safely identified.
      //
      // Recall fix (novelty prioritization): a standalone candidate now
      // attempts identity REGARDLESS of pass/fail, so its outcome can be
      // recorded below -- but a REJECTED candidate must never pay for the
      // costly third-party search+AI resolution (the exact same cost-control
      // guarantee as before this fix). Passing `async () => null` as
      // resolveIdentity makes resolveCandidateCompanyIdentity take ONLY its
      // free first-party fast path (qualification.sourceIsFirstParty + a
      // safe, non-corporate evidence domain) and return null otherwise --
      // zero extra network/AI calls either way. A QUALIFIED standalone
      // candidate still gets EXACTLY today's real resolution (free fast
      // path, falling back to the real costly search when needed), computed
      // ONCE here and reused for persistence below -- never resolved twice.
      let identity: { companyName: string; companyDomain: string } | null;
      if (entry.kind === "group") {
        identity = { companyName: qualification.subjectCompanyName, companyDomain: entry.canonicalDomain };
      } else if (qualificationResult.priority !== null) {
        // Cost control: the real (potentially costly) identity resolution
        // path only runs for evidence that already clears the qualification
        // bar -- unqualified evidence is never persisted regardless of whose
        // identity it names, so resolving it would be wasted spend.
        identity = await resolveCandidateCompanyIdentity(qualification, primary.evidenceDomain);
      } else {
        identity = await resolveCandidateCompanyIdentity(qualification, primary.evidenceDomain, async () => null);
      }

      // Recall fix (novelty prioritization): record a durable evaluation
      // outcome once a real AI decision exists -- this point is only ever
      // reached after qualify() already succeeded above; a candidate-level
      // unusable response or a provider-wide failure already `continue`d/
      // threw before ever reaching here, so a transient failure is
      // structurally impossible to record as a rejection. Recorded
      // regardless of pass/fail, but only when a safe identity was actually
      // established -- a rejected standalone candidate whose only path to
      // identity is the costly third-party search (never attempted for a
      // rejection, see above) simply gets no durable memory this run; it may
      // be re-evaluated again on a future run, which is no worse than
      // today's behavior, never a correctness risk.
      if (identity) {
        await recordDiscoveryEvaluation({
          domain: identity.companyDomain,
          outcome: qualificationResult.priority !== null ? "qualified" : "rejected",
          territoryId: territory.id,
          scanRunId: runId,
        });
      }

      if (qualificationResult.priority === null) continue;
      candidatesQualified++;
      await writeScanRunProgress(runId, { candidatesQualified });

      if (!identity) {
        logger.warn(
          { subjectCompanyName: qualification.subjectCompanyName, evidenceUrl: primary.url },
          "Discovery: company identity could not be resolved; candidate skipped",
        );
        continue; // never persist the publisher's identity in place of the real company
      }

      // One signal per evidence item DeepSeek actually grounded its answer
      // in (qualification.evidenceUrls, a subset of what was given) --
      // generalizes the pre-P3A single-item logic to however many items
      // were actually sent (1-3); source provenance stays attached
      // per-item, never collapsed into one row.
      const evidenceByUrl = new Map(evidenceItems.map((item) => [item.url, item]));
      const candidate: Candidate = {
        companyName: identity.companyName,
        domain: identity.companyDomain,
        country: "Unknown",
        partnerType: qualification.partnerType,
        recruitmentArchetype: qualification.recruitmentArchetype,
        checks,
        whyItFits: qualification.whyItFits,
        whyNow: qualification.whyNow,
        suggestedAngle: qualification.suggestedAngle,
        suggestedTargetRole: qualification.suggestedTargetRole,
        signals: qualification.evidenceUrls
          .map((url) => evidenceByUrl.get(url))
          .filter((item): item is AnnotatedResult => !!item) // never fabricate a source URL outside what was actually given as evidence
          .map((item) => ({
            signalType: qualification.signalType,
            title: item.title,
            summary: item.snippet,
            sourceUrl: item.url,
            sourceDomain: item.evidenceDomain, // always the evidence source domain -- may legitimately differ from companyDomain above
            publishedAt: item.publishedAt, // honest: null when the provider gave no date, never defaulted to "today"
            confidence: "medium" as Confidence,
            rawExcerpt: item.text.slice(0, 400),
          })),
      };
      // resultsFound (candidates.length, computed by the caller) counts
      // every candidate that reached this point, regardless of the
      // excluded-domain gate just below -- unchanged from before this
      // hotfix, see the excludedDomains comment above.
      candidates.push(candidate);

      // Product decision (hotfix): persist immediately, not batched until
      // the whole run succeeds -- so a later candidate's provider failure
      // can never discard a candidate that already fully cleared
      // qualification + identity resolution. Same persistCandidate call,
      // same transaction/dedupe/evidence/canonicalization behavior as
      // before Phase 11.6.1 P3A; only how the candidate/evidence set was
      // assembled changed. candidate.domain is always the resolved,
      // registrable company domain -- the correctness net for the early
      // evidenceDomain check above: an exclusion is never missed just
      // because the evidence happened to come from a third-party source.
      if (!isExcludedDomain(candidate.domain, excludedDomains) && !isDomainExcluded(candidate.domain, discoveryExclusionDomains)) {
        const created = await persistCandidate(candidate, qualificationResult, territory, "connected");
        if (created) prospectsCreated++;
      }
    }

    return {
      candidates,
      stats: {
        queriesRun,
        uniqueCompaniesSeen,
        newCompaniesCount,
        duplicatesRemoved,
        candidatesSentToLlm,
        candidatesQualified,
        candidatesSkippedRecent,
        prospectsCreated,
        stoppedReason,
      },
    };
  } catch (err) {
    const notImplemented =
      err instanceof searchProvider.SearchNotImplementedError ||
      err instanceof extractionProvider.ExtractionNotImplementedError ||
      err instanceof aiProvider.AiNotImplementedError;
    if (notImplemented) return null; // honest fallback, not an operational failure
    throw err;
  }
}

// ---- Persistence -----------------------------------------------------------

// The exact transaction type drizzle-orm passes into db.transaction's callback.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Resolves the canonical company row for candidate.domain (already the
// registrable domain -- see resolveCandidateCompanyIdentity), creating one
// if none exists yet. Tolerant of legacy rows written before Phase 3A:
// compares by canonical form, not raw string equality, so a new candidate
// for "uipath.com" still finds an old "www.uipath.com"/"ir.uipath.com" row
// instead of creating a second one, without requiring any migration or
// data rewrite (Phase 3A deliberately never mutates existing rows -- see
// the read-only audit tool for reviewing what already exists).
//
// Concurrency: guarded by a transaction-scoped Postgres advisory lock keyed
// on a hash of the canonical domain. Two concurrent scans (e.g. different
// territories, or two admin-triggered runs) discovering the same real
// company at the same time would otherwise both SELECT before either
// INSERTs -- a real race under Postgres's default READ COMMITTED isolation
// (see the Phase 3 audit). pg_advisory_xact_lock is DB-level and
// process-safe (unlike an in-memory JS mutex, which only protects a single
// server process/instance): the second transaction blocks here until the
// first commits and releases the lock, at which point its own SELECT sees
// the first transaction's already-committed row. A hash collision between
// two different domains only causes harmless extra serialization, never an
// incorrect match -- the lookup below still compares real canonical domain
// strings, never the hash itself.
//
// Phase 3B: a real `companies_domain_unique` partial unique index now also
// exists at the DB level -- the lock is kept anyway, deliberately, as the
// two serve different purposes. The DB index is the final, universal
// guarantee across every write path (including ones that don't go through
// this function, e.g. Portfolio manual-add / PAM book import, which are
// not lock-protected). The advisory lock is what keeps THIS path
// (Discovery, the one genuinely concurrent trigger -- multiple
// admin-initiated scans can race) from ever hitting that constraint as a
// real 23505 unique-violation exception: nothing in persistCandidate or
// its callers catches one, so an unprotected race here would surface as an
// unhandled error and could fail an otherwise-healthy scan run for what is
// really just an expected, harmless race. With the lock, the second
// transaction blocks and then cleanly finds the first transaction's row
// instead of ever attempting a colliding INSERT.
//
// Exported for testing -- DB-backed (needs a real transaction), so covered
// by the disposable-Postgres test suite rather than a pure/local one.
export async function resolveOrCreateCanonicalCompany(tx: Tx, candidate: Candidate): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${candidate.domain})::bigint)`);

  const existingCompanies = await tx.select().from(companiesTable).where(isNotNull(companiesTable.domain));
  const existing = existingCompanies.find((c) => toRegistrableDomain(c.domain) === candidate.domain);
  if (existing) return existing.id;

  const [created] = await tx
    .insert(companiesTable)
    .values({
      name: candidate.companyName,
      normalizedName: candidate.companyName.toLowerCase(),
      domain: candidate.domain,
      websiteUrl: `https://${candidate.domain}`,
      country: candidate.country,
    })
    .returning();
  return created!.id;
}

type TerritorySuppression = { kind: "active_prospect"; prospectId: string } | { kind: "portfolio" };

// Phase 3A territory-scoped suppression: a company already prospected
// (status != "rejected" -- this also covers a company already in
// Recruitment, since accepting a prospect only ever changes its status to
// "accepted"/"pushed_to_hubspot", never away from prospects, and
// partner_recruitments cascade-deletes with its originating prospect, so a
// Recruitment can never outlive/outreach beyond its prospect) or already a
// signed Portfolio partner in this SAME territory blocks a new prospect
// here -- but never blocks a prospect for the same canonical company in a
// DIFFERENT territory (identity is global; lifecycle is territory-scoped).
// Portfolio suppression is a separate, explicit check because a
// Portfolio-only company (manual add / PAM book import) may have no
// prospect row at all to be caught by the first check.
async function findTerritorySuppression(tx: Tx, companyId: string, territoryId: string): Promise<TerritorySuppression | null> {
  const [activeProspect] = await tx
    .select()
    .from(prospectsTable)
    .where(and(eq(prospectsTable.companyId, companyId), eq(prospectsTable.territoryId, territoryId), ne(prospectsTable.status, "rejected")));
  if (activeProspect) return { kind: "active_prospect", prospectId: activeProspect.id };

  const [relationship] = await tx
    .select({ id: partnerRelationshipsTable.id })
    .from(partnerRelationshipsTable)
    .where(and(eq(partnerRelationshipsTable.companyId, companyId), eq(partnerRelationshipsTable.territoryId, territoryId)));
  if (relationship) return { kind: "portfolio" };

  return null;
}

function isExcludedDomain(domain: string, excludedDomains: string[]): boolean {
  return excludedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// Persists one qualified candidate (company + evidence + prospect +
// activity) inside a single transaction, so a mid-candidate insert failure
// can never leave a half-created company/prospect behind. Returns whether a
// new prospect was actually created (false when suppressed).
//
// Phase 3A evidence preservation: the canonical company row and this
// candidate's signals are ALWAYS persisted once identity resolves --
// territory suppression only ever withholds creating a SECOND
// prospect/company for a canonical company already active in this
// territory. Previously, a dedupe skip discarded the candidate's
// freshly-qualified evidence entirely; now a second qualified result for
// the same canonical company + territory still attaches its evidence to
// the existing company (and refreshes the existing prospect's freshness
// timestamp) -- it just never creates a duplicate prospect or company row.
// Exported for testing -- see resolveOrCreateCanonicalCompany above.
export async function persistCandidate(
  candidate: Candidate,
  qualification: QualificationResult,
  territory: Territory,
  dataStatus: "demo" | "connected",
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const companyId = await resolveOrCreateCanonicalCompany(tx, candidate);

    await tx.insert(signalsTable).values(candidate.signals.map((s) => ({ companyId, ...s })));

    // Hotfix: recruitment eligibility. The canonical company and this
    // candidate's evidence are preserved above regardless -- a technology
    // vendor (or an unclassified "other") still resolves canonical identity
    // and keeps its evidence/context, it just never enters the PAM
    // recruitment funnel as a prospect. Logged (not counted in a new
    // schema field -- see the hotfix report) so a filtered candidate is
    // never silently invisible.
    if (!isEligibleRecruitmentArchetype(candidate.recruitmentArchetype)) {
      logger.info(
        { companyName: candidate.companyName, domain: candidate.domain, recruitmentArchetype: candidate.recruitmentArchetype, territoryId: territory.id },
        "Discovery: candidate filtered -- ineligible recruitment archetype, no prospect created",
      );
      return false;
    }

    const suppression = await findTerritorySuppression(tx, companyId, territory.id);
    if (suppression) {
      if (suppression.kind === "active_prospect") {
        // Cost-control B's freshness rule (shouldReuseExistingQualification)
        // only works going forward if a re-qualification actually refreshes
        // this timestamp -- reaching this branch means new evidence for an
        // already-active prospect just arrived, so the reuse window resets
        // from now.
        await tx.update(prospectsTable).set({ lastResearchedAt: new Date() }).where(eq(prospectsTable.id, suppression.prospectId));
      }
      return false; // evidence already attached above; no second prospect/company in this territory
    }

    const [prospect] = await tx
      .insert(prospectsTable)
      .values({
        companyId,
        territoryId: territory.id,
        // Role-separation hotfix: a newly discovered prospect starts
        // unassigned -- it is no longer auto-handed to the territory's PAM
        // at creation time. Only an explicit Head/Admin assignment (see
        // routes/prospects.ts's admin-only assigned_user_id handling) makes
        // it visible to a PAM. Existing rows created before this change are
        // deliberately left untouched (see the Stage report's legacy-data
        // reconciliation note) -- this only affects new rows from here on.
        assignedUserId: null,
        partnerType: candidate.partnerType,
        priority: qualification.priority as "A" | "B",
        enterpriseAccess: candidate.checks.enterpriseAccess,
        relevantCapability: candidate.checks.relevantCapability,
        technologyAdjacency: candidate.checks.technologyAdjacency,
        partnershipOpenness: candidate.checks.partnershipOpenness,
        recentTrigger: candidate.checks.recentTrigger,
        whyItFits: candidate.whyItFits,
        whyNow: candidate.whyNow,
        suggestedAngle: candidate.suggestedAngle,
        suggestedTargetRole: candidate.suggestedTargetRole,
        status: "new",
        discoverySourceStatus: dataStatus,
        priorityRationale: qualification.rationale,
        lastResearchedAt: new Date(),
      })
      .returning();

    await tx.insert(prospectActivityTable).values({
      prospectId: prospect!.id,
      eventType: "discovered",
      note: qualification.rationale,
    });

    return true;
  });
}

export interface DiscoveryOutcome {
  run: typeof scanRunsTable.$inferSelect;
  prospectsCreated: number;
}

// Thrown only by runDiscoveryForConfig's catch below, carrying nothing but
// the already-sanitized user-facing message -- callers (e.g. scans.ts) never
// need to re-classify, and can never accidentally surface a raw internal
// error just by reading .message off whatever they catch.
export class DiscoveryScanFailedError extends Error {}

export interface DiscoveryFailureClassification {
  stoppedReason: (typeof SCAN_RUN_STOPPED_REASONS)[number];
  message: string;
}

// Production hotfix: AiProviderError.code/SearchProviderError.code (already
// a small closed set of internal classifications -- never the raw provider
// response) previously collapsed into one generic message per provider and
// were never persisted as stopped_reason at all, which is why a real
// production failure (AI qualification timing out mid-scan) showed
// stopped_reason=NULL and an uninformative message. Every mapped code below
// is bounded and non-sensitive; nothing here ever touches err.message,
// a response body, a header, or a stack trace.
const AI_ERROR_CLASSIFICATION: Record<string, DiscoveryFailureClassification> = {
  timeout: {
    stoppedReason: "ai_timeout",
    message: "AI qualification timed out. Search work completed, but qualification did not finish in time. Please retry the scan.",
  },
  network_error: {
    stoppedReason: "ai_network_error",
    message: "Could not reach the AI provider during qualification. Please retry the scan.",
  },
  http_error: {
    stoppedReason: "ai_http_error",
    message: "The AI provider returned an error during qualification. Please retry or check the AI connection in Admin.",
  },
  oversized_response: {
    stoppedReason: "ai_oversized_response",
    message: "AI qualification returned an unusable response. Please retry the scan.",
  },
  malformed_json: {
    stoppedReason: "ai_malformed_response",
    message: "AI qualification returned an unusable response. Please retry the scan.",
  },
  empty_response: {
    stoppedReason: "ai_empty_response",
    message: "AI qualification returned an unusable response. Please retry the scan.",
  },
  truncated: {
    stoppedReason: "ai_truncated_response",
    message: "AI qualification returned an unusable response. Please retry the scan.",
  },
  schema_invalid: {
    stoppedReason: "ai_schema_invalid",
    message: "AI qualification returned an unusable response. Please retry the scan.",
  },
};

const SEARCH_ERROR_CLASSIFICATION: Record<string, DiscoveryFailureClassification> = {
  timeout: { stoppedReason: "search_timeout", message: "Web search timed out. Please retry the scan." },
  network_error: { stoppedReason: "search_network_error", message: "Could not reach the search provider. Please retry the scan." },
  http_error: {
    stoppedReason: "search_http_error",
    message: "The search provider returned an error. Please retry or check the Web Search connection in Admin.",
  },
  oversized_response: { stoppedReason: "search_oversized_response", message: "Web search returned an unusable response. Please retry the scan." },
  malformed_json: { stoppedReason: "search_malformed_response", message: "Web search returned an unusable response. Please retry the scan." },
  malformed_response: { stoppedReason: "search_malformed_response", message: "Web search returned an unusable response. Please retry the scan." },
};

// Classifies the *typed* error object -- not a message string read back out
// of the DB later -- into a stable, hand-written, bounded (stoppedReason,
// message) pair. The NotImplemented branches are unreachable via the live
// path today (attemptLiveDiscovery already intercepts *NotImplementedError
// internally and falls back to demo), but stay as defense-in-depth and
// become live the moment one provider is implemented while others remain
// stubbed. Exported for direct unit testing without needing a live provider
// call or a thrown exception from real network code.
export function classifyDiscoveryFailure(err: unknown): DiscoveryFailureClassification {
  if (err instanceof searchProvider.SearchNotImplementedError) return { stoppedReason: "error", message: "Search provider not connected." };
  if (err instanceof extractionProvider.ExtractionNotImplementedError) {
    return { stoppedReason: "error", message: "Page extraction provider not connected." };
  }
  if (err instanceof aiProvider.AiNotImplementedError) return { stoppedReason: "error", message: "AI qualification provider not connected." };

  if (err instanceof aiProvider.AiProviderError) {
    return AI_ERROR_CLASSIFICATION[err.code] ?? { stoppedReason: "error", message: "AI qualification call failed. Please try again." };
  }
  if (err instanceof searchProvider.SearchProviderError) {
    return SEARCH_ERROR_CLASSIFICATION[err.code] ?? { stoppedReason: "error", message: "Web search provider call failed. Please try again." };
  }
  return { stoppedReason: "error", message: "Discovery scan could not be completed. Please try again or contact an administrator." };
}

export async function runDiscoveryForConfig(scanConfigId: string): Promise<DiscoveryOutcome> {
  const [config] = await db.select().from(scanConfigsTable).where(eq(scanConfigsTable.id, scanConfigId));
  if (!config) throw new Error("Scan config not found");
  const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, config.territoryId));
  if (!territory) throw new Error("Territory not found for scan config");

  // Recorded up front as "running" so a crash mid-run never leaves a scan
  // silently missing from the history -- it shows up as "failed" instead.
  const [run] = await db
    .insert(scanRunsTable)
    .values({ scanConfigId: config.id, status: "running", dataStatus: "demo" })
    .returning();

  try {
    const liveResult = await attemptLiveDiscovery(config, territory, run!.id);
    const dataStatus: "demo" | "connected" = liveResult ? "connected" : "demo";
    const candidates = liveResult?.candidates ?? generateDemoCandidates(config, territory);
    const excludedDomains = (config.excludedDomains as string[]) ?? [];
    // Phase 11.5A: only reached by the demo path below (the live path
    // already applied this inside attemptLiveDiscovery) -- kept consistent
    // so a PAM's exclusion is honored the same way regardless of whether a
    // scan happened to run live or demo.
    const discoveryExclusionDomains = liveResult ? null : await loadActiveExclusionDomains(territory.id);

    // Product decision (hotfix): a live candidate is already persisted the
    // moment it clears qualification + identity resolution, inside
    // attemptLiveDiscovery itself (see its persistence block) -- so it must
    // never be re-persisted here, which would either double-insert or
    // silently no-op via resolveOrCreateCanonicalCompany/
    // findTerritorySuppression's dedupe and under-report qualifiedCount.
    // Only the demo path (which has no provider-failure mode and was never
    // in scope for this change) still qualifies+persists candidates in this
    // loop, exactly as before.
    let qualifiedCount: number;
    if (liveResult) {
      qualifiedCount = liveResult.stats.prospectsCreated;
    } else {
      qualifiedCount = 0;
      for (const candidate of candidates) {
        if (isExcludedDomain(candidate.domain, excludedDomains)) continue;
        if (discoveryExclusionDomains && isDomainExcluded(candidate.domain, discoveryExclusionDomains)) continue;
        const qualification = qualifyChecks(candidate.checks, config.minChecksRequired);
        if (!qualification.priority) continue;

        const created = await persistCandidate(candidate, qualification, territory, dataStatus);
        if (created) qualifiedCount++;
      }
    }

    // Stage 6.5: run-level search-productivity stats only exist on the live
    // (dataStatus="connected") path -- a demo run leaves them at their
    // schema defaults (0/null), which Territory Potential's saturation
    // logic treats as "no real search productivity data", never as zero
    // yield (see territoryPotentialService.ts).
    const [completedRun] = await db
      .update(scanRunsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        resultsFound: candidates.length,
        resultsQualified: qualifiedCount,
        dataStatus,
        ...(liveResult
          ? {
              queriesRun: liveResult.stats.queriesRun,
              uniqueCompaniesSeen: liveResult.stats.uniqueCompaniesSeen,
              newCompaniesCount: liveResult.stats.newCompaniesCount,
              duplicatesRemoved: liveResult.stats.duplicatesRemoved,
              candidatesSentToLlm: liveResult.stats.candidatesSentToLlm,
              candidatesQualified: liveResult.stats.candidatesQualified,
              candidatesSkippedRecent: liveResult.stats.candidatesSkippedRecent,
              stoppedReason: liveResult.stats.stoppedReason,
            }
          : {}),
      })
      .where(eq(scanRunsTable.id, run!.id))
      .returning();

    return { run: completedRun!, prospectsCreated: qualifiedCount };
  } catch (err) {
    const { stoppedReason, message: safeMessage } = classifyDiscoveryFailure(err);

    // Bounded, safe diagnostic fields only -- never the raw err.message or
    // a raw exception object. A message string can itself embed a DB URL,
    // credential, token, or SQL text (e.g. the Postgres driver includes the
    // failing query/constraint in its error message), and pino's redact
    // list only covers header paths, not arbitrary message text. If richer
    // raw diagnostics are needed later, they must go through an explicit
    // secret-redacting sanitizer first -- not logged verbatim here.
    logger.error(
      { scanConfigId, errorName: err instanceof Error ? err.name : typeof err, stoppedReason, safeMessage },
      "Discovery scan failed",
    );

    // Deliberately does NOT set queriesRun/uniqueCompaniesSeen/
    // newCompaniesCount/duplicatesRemoved/candidatesSentToLlm/
    // candidatesQualified here -- those were already written incrementally
    // as real checkpoints during attemptLiveDiscovery (see
    // writeScanRunProgress), so whatever the run genuinely completed before
    // failing stays on the row. Only the terminal fields change.
    await db
      .update(scanRunsTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: safeMessage,
        stoppedReason,
      })
      .where(eq(scanRunsTable.id, run!.id));
    throw new DiscoveryScanFailedError(safeMessage);
  }
}
