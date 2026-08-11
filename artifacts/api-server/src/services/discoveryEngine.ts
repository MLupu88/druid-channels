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
import {
  decideNextBatch,
  computeNewCandidateYield,
  shouldReuseExistingQualification,
  QUERIES_PER_BATCH,
  MAX_CANDIDATES_TO_LLM,
  type BudgetStopReason,
  type ExistingQualificationRecord,
} from "./discoveryBudget";
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
  checks: FiveChecks;
  whyItFits: string;
  whyNow: string;
  suggestedAngle: string;
  suggestedTargetRole: string;
  signals: CandidateSignal[];
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
    adjacencies: ["Genesys", "NiCE", "Cisco", "Amazon Connect", "Five9", "Avaya"],
    industries: ["Banking", "Insurance", "Retail"],
    druidAngle: "Add an enterprise AI-agent and process-completion layer to the firm's existing contact-center transformation programs.",
    namePool: ["Northbridge", "Meridian", "Anchorline", "Vantage", "Solstice", "Fieldstone"],
    suffixPool: ["Contact Systems", "CX Group", "Voice Technologies"],
  },
  {
    id: "automation_workflow_specialist",
    label: "Automation & workflow specialist",
    adjacencies: ["UiPath", "ServiceNow", "Microsoft Power Platform", "Salesforce", "SAP", "Oracle"],
    industries: ["Healthcare", "Higher education", "Banking"],
    druidAngle: "Give the firm's customers and employees a conversational way to access and orchestrate the workflows it already automates.",
    namePool: ["Brightline", "Elevate", "Novara", "Corewave", "Pathforge", "Ridgeline"],
    suffixPool: ["Automation Partners", "Digital Workflows", "Process Consulting"],
  },
  {
    id: "ai_data_consultancy",
    label: "AI & data consultancy",
    adjacencies: ["Microsoft", "AWS", "Google Cloud", "NVIDIA"],
    industries: ["Retail", "Banking", "Healthcare"],
    druidAngle: "Move the firm from AI advisory and prototypes to production-grade enterprise AI agents.",
    namePool: ["Lumenova", "Datashift", "Cognivant", "Insightra", "Nexalytics", "Trueline"],
    suffixPool: ["AI Consulting", "Data & AI", "Analytics Group"],
  },
  {
    id: "bpo_managed_service",
    label: "BPO / managed service provider",
    adjacencies: ["Genesys", "ServiceNow", "Salesforce"],
    industries: ["Banking", "Healthcare", "Insurance"],
    druidAngle: "Package DRUID's AI agents inside the firm's recurring managed-service proposition.",
    namePool: ["Anchorpoint", "Summit", "Continuum", "Everbridge", "Keystone", "Farlight"],
    suffixPool: ["Managed Services", "Operations Group", "Support Solutions"],
  },
  {
    id: "telco_msp",
    label: "Telco / enterprise MSP",
    adjacencies: ["Cisco", "Microsoft", "AWS"],
    industries: ["Retail", "Banking", "Public sector"],
    druidAngle: "Combine DRUID with the firm's cloud, communications, and managed-services stack for enterprise customers.",
    namePool: ["Wavepoint", "Circuitline", "Meshworks", "Signalbridge", "Fibercore", "Netform"],
    suffixPool: ["Communications", "Enterprise Networks", "Managed Cloud"],
  },
  {
    id: "vertical_specialist",
    label: "Vertical specialist",
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
// Search Criteria profile -- not just technologies x industries. Balanced
// across whichever dimensions are actually configured: a rich zip pass so
// every present dimension (including partner type) shows up starting at
// query #1, then a round-robin fill across pairwise families so no single
// Cartesian family can consume the whole budget before others get a turn.
// Countries rotate via index, never cross-multiplied. Deduplicated, capped
// at MAX_AUTOMATIC_QUERIES, and never padded when the profile is narrow.
export function buildAutomaticQueries(config: ScanConfig, territory: Territory): string[] {
  const industries = (config.industries as string[]) ?? [];
  const technologies = (config.technologies as string[]) ?? [];
  const countries = (territory.countries as string[]) ?? [];
  const partnerTypeTerms = ((config.partnerTypes as string[]) ?? []).flatMap(partnerTypeSearchVariants);
  const geoSuffix = (i: number) => (countries.length > 0 ? ` ${countries[i % countries.length]}` : "");
  // Rotated the same way as geoSuffix -- every configured target signal
  // gets represented across the query set without multiplying query count
  // (no extra search calls per signal).
  const signalTerms = ((config.targetSignals as string[]) ?? []).map((s) => TARGET_SIGNAL_SEARCH_TERMS[s]).filter((t): t is string => !!t);
  const signalSuffix = (i: number) => (signalTerms.length > 0 ? ` ${signalTerms[i % signalTerms.length]}` : "");

  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const trimmed = q.trim();
    if (trimmed && !seen.has(trimmed) && queries.length < MAX_AUTOMATIC_QUERIES) {
      seen.add(trimmed);
      queries.push(trimmed);
    }
  };

  const presentDims = [technologies.length > 0, partnerTypeTerms.length > 0, industries.length > 0].filter(Boolean).length;
  if (presentDims >= 2) {
    const steps = Math.max(technologies.length, partnerTypeTerms.length, industries.length);
    for (let i = 0; i < steps && queries.length < MAX_AUTOMATIC_QUERIES; i++) {
      const parts: string[] = [];
      if (technologies.length > 0) parts.push(`"${technologies[i % technologies.length]}"`);
      if (partnerTypeTerms.length > 0) parts.push(`"${partnerTypeTerms[i % partnerTypeTerms.length]}"`);
      if (industries.length > 0) parts.push(industries[i % industries.length]);
      push(`${parts.join(" ")}${signalSuffix(i)}${geoSuffix(i)}`);
    }
  }

  const families: Array<() => string> = [];
  if (technologies.length > 0 && industries.length > 0) {
    let a = 0;
    families.push(() => `"${technologies[a % technologies.length]} partner" ${industries[a++ % industries.length]}`);
  }
  if (technologies.length > 0 && partnerTypeTerms.length > 0) {
    let a = 0;
    families.push(() => `"${technologies[a % technologies.length]}" "${partnerTypeTerms[a++ % partnerTypeTerms.length]}"`);
  }
  if (partnerTypeTerms.length > 0 && industries.length > 0) {
    let a = 0;
    families.push(() => `"${partnerTypeTerms[a % partnerTypeTerms.length]}" ${industries[a++ % industries.length]}`);
  }
  for (let round = 0; round < MAX_AUTOMATIC_QUERIES * 3 && queries.length < MAX_AUTOMATIC_QUERIES && families.length > 0; round++) {
    for (const family of families) {
      if (queries.length >= MAX_AUTOMATIC_QUERIES) break;
      push(`${family()}${signalSuffix(round)}${geoSuffix(round)}`);
    }
  }

  // At most one dimension was ever configured (e.g. only industries) --
  // the passes above intentionally produce nothing for that case, so
  // search still gets *something* rather than an empty query list.
  if (queries.length === 0) {
    for (const tech of technologies) push(`"${tech} partner"${signalSuffix(queries.length)}${geoSuffix(queries.length)}`);
    for (const pt of partnerTypeTerms) push(`"${pt}"${signalSuffix(queries.length)}${geoSuffix(queries.length)}`);
    for (const ind of industries) push(`${ind} technology partner${signalSuffix(queries.length)}${geoSuffix(queries.length)}`);
  }

  // Only target_signals were ever configured (no technologies, partner
  // types, or industries at all) -- give search something signal-shaped
  // to work with rather than an empty query list.
  if (queries.length === 0 && signalTerms.length > 0) {
    for (const term of signalTerms) push(`"${term}"${geoSuffix(queries.length)}`);
  }

  return queries;
}

function buildSearchQueries(config: ScanConfig, territory: Territory): string[] {
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

// Only called for third-party evidence about a candidate that already
// passed qualification (see the cost-control gate in attemptLiveDiscovery
// below). Never invents a domain: DeepSeek is only ever shown the Tavily
// results below and must say "unresolved" rather than recall a domain from
// its own general knowledge. Any failure (search or AI call) is treated
// the same as "could not resolve" -- logged and skipped, never allowed to
// fail the whole scan over one candidate's identity lookup.
async function resolveCompanyIdentity(subjectCompanyName: string): Promise<{ name: string; domain: string } | null> {
  try {
    const results = await searchProvider.search(`"${subjectCompanyName}" official website`, { maxResults: 3 });
    if (results.length === 0) return null;
    return await aiProvider.identifyCompany({
      subjectCompanyName,
      candidates: results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet })),
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
  return { companyName: resolved.name, companyDomain: resolvedRegistrableDomain };
}

export interface LiveDiscoveryStats {
  queriesRun: number;
  uniqueCompaniesSeen: number;
  newCompaniesCount: number;
  duplicatesRemoved: number;
  candidatesSentToLlm: number;
  candidatesQualified: number;
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
  patch: Partial<Pick<LiveDiscoveryStats, "queriesRun" | "uniqueCompaniesSeen" | "newCompaniesCount" | "duplicatesRemoved" | "candidatesSentToLlm" | "candidatesQualified">>,
): Promise<void> {
  await db.update(scanRunsTable).set(patch).where(eq(scanRunsTable.id, runId));
}

// Stage 6.5 Cost-Aware Adaptive Discovery: bounded initial batch -> evaluate
// new-candidate yield -> optional bounded expansion -> stop on a hard cap or
// sustained poor yield (see discoveryBudget.ts's decideNextBatch). Territory
// size affects how much of the existing MAX_QUERIES_PER_RUN/
// MAX_CANDIDATES_TO_LLM ceiling a run actually uses -- it never raises the
// ceiling itself, and it never changes qualifyChecks' qualification bar.
async function attemptLiveDiscovery(config: ScanConfig, territory: Territory, runId: string): Promise<LiveDiscoveryResult | null> {
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
    const candidates: Candidate[] = [];
    // Cross-query dedup: the same URL can legitimately surface from more
    // than one query variant (see buildAutomaticQueries) -- only qualify it
    // once, both to avoid duplicate prospects and to avoid spending a
    // second AI call on evidence already assessed.
    const seenUrls = new Set<string>();
    // Cost control A/C (company-level dedupe + evidence dedupe before
    // DeepSeek): domains already seen earlier in *this* run never get a
    // second AI call. Honest limitation: this only catches first-party
    // evidence (evidenceDomain === the candidate's own domain) pre-call --
    // third-party evidence's real subject company isn't known until after
    // qualification, so it's still deduped, just at persistence time
    // (upsertCompanyOrSkip) rather than before spending on it.
    const seenDomainsThisRun = new Set<string>();

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

    let queriesRun = 0;
    let candidatesSentToLlm = 0;
    let candidatesQualified = 0;
    let duplicatesRemoved = 0;
    let uniqueCompaniesSeen = 0;
    let newCompaniesCount = 0;
    let prospectsCreated = 0;
    let stoppedReason: BudgetStopReason = "completed";
    const recentYields: number[] = [];

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
        const results = await searchProvider.search(query, { maxResults: config.maxResults });
        for (const result of results) {
          batchRaw++;
          if (seenUrls.has(result.url)) {
            duplicatesRemoved++;
            continue;
          }
          seenUrls.add(result.url);

          const evidenceDomain = extractDomain(result.url);

          if (seenDomainsThisRun.has(evidenceDomain)) {
            duplicatesRemoved++;
            batchUnique++;
            continue;
          }
          seenDomainsThisRun.add(evidenceDomain);
          batchUnique++;

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
            // company) -- falls through to a real (refresh) qualification
            // below, but is still not counted as a NEW company for yield.
          } else {
            newCompaniesCount++;
            batchNew++;
          }
          uniqueCompaniesSeen++;

          if (candidatesSentToLlm >= MAX_CANDIDATES_TO_LLM) continue; // hard cap -- never exceeded

          // Tavily's search result already carries usable content -- no
          // second external call. extract() only validates/bounds it.
          const page = await extractionProvider.extract(result.url, { text: result.snippet, publishedAt: result.publishedAt });
          // Checkpoint 3: recorded as "sent" the moment the call is made,
          // before awaiting the result -- if qualify() itself throws
          // (timeout, network error, etc.), this candidate genuinely was
          // sent, and that fact is already durable.
          candidatesSentToLlm++;
          await writeScanRunProgress(runId, { candidatesSentToLlm });
          const qualification = await aiProvider.qualify({
            companyName: result.title,
            domain: evidenceDomain,
            evidence: [{ url: result.url, text: page.text }],
            criteria,
          });

          const checks: FiveChecks = {
            enterpriseAccess: qualification.enterpriseAccess,
            relevantCapability: qualification.relevantCapability,
            technologyAdjacency: qualification.technologyAdjacency,
            partnershipOpenness: qualification.partnershipOpenness,
            recentTrigger: qualification.recentTrigger,
          };

          // Same qualification bar regardless of territory -- qualifyChecks
          // and config.minChecksRequired are untouched by anything in this
          // adaptive-budget loop. Result is kept (not just null-checked) --
          // it's the exact QualificationResult persistCandidate needs below,
          // never recomputed a second time.
          const qualificationResult = qualifyChecks(checks, config.minChecksRequired);
          if (qualificationResult.priority === null) continue;
          candidatesQualified++;
          await writeScanRunProgress(runId, { candidatesQualified });

          // Cost control: identity resolution (an extra search + AI call)
          // only runs for evidence that already clears the qualification bar
          // -- unqualified evidence is never persisted regardless of whose
          // identity it names, so resolving it would be wasted spend.
          const identity = await resolveCandidateCompanyIdentity(qualification, evidenceDomain);
          if (!identity) {
            logger.warn(
              { subjectCompanyName: qualification.subjectCompanyName, evidenceUrl: result.url },
              "Discovery: company identity could not be resolved; candidate skipped",
            );
            continue; // never persist the publisher's identity in place of the real company
          }

          const candidate: Candidate = {
            companyName: identity.companyName,
            domain: identity.companyDomain,
            country: "Unknown",
            partnerType: qualification.partnerType,
            checks,
            whyItFits: qualification.whyItFits,
            whyNow: qualification.whyNow,
            suggestedAngle: qualification.suggestedAngle,
            suggestedTargetRole: qualification.suggestedTargetRole,
            signals: qualification.evidenceUrls
              .filter((url) => url === result.url) // never fabricate a source URL outside what was actually given as evidence
              .map((url) => ({
                signalType: qualification.signalType,
                title: result.title,
                summary: result.snippet,
                sourceUrl: url,
                sourceDomain: evidenceDomain, // always the evidence source domain -- may legitimately differ from companyDomain above
                publishedAt: page.publishedAt, // honest: null when the provider gave no date, never defaulted to "today"
                confidence: "medium" as Confidence,
                rawExcerpt: page.text.slice(0, 400),
              })),
          };
          // resultsFound (candidates.length, computed by the caller) counts
          // every candidate that reached this point, regardless of the
          // excluded-domain gate just below -- unchanged from before this
          // hotfix, see the excludedDomains comment above.
          candidates.push(candidate);

          // Product decision (hotfix): persist immediately, not batched
          // until the whole run succeeds -- so a later candidate's provider
          // failure can never discard a candidate that already fully
          // cleared qualification + identity resolution. Same
          // persistCandidate call, same transaction/dedupe/evidence/
          // canonicalization behavior as the pre-hotfix batched call; only
          // WHEN it runs has changed.
          if (!isExcludedDomain(candidate.domain, excludedDomains)) {
            const created = await persistCandidate(candidate, qualificationResult, territory, "connected");
            if (created) prospectsCreated++;
          }
        }

        // Checkpoint 1/2: after this query's results are fully searched and
        // deduped -- queriesRun, plus the dedupe counters as they stand so
        // far this run. One write per completed query, never per result.
        await writeScanRunProgress(runId, { queriesRun, uniqueCompaniesSeen, newCompaniesCount, duplicatesRemoved });
      }

      recentYields.push(computeNewCandidateYield({ rawResults: batchRaw, uniqueCompanies: batchUnique, newCompanies: batchNew }));
    }

    return {
      candidates,
      stats: { queriesRun, uniqueCompaniesSeen, newCompaniesCount, duplicatesRemoved, candidatesSentToLlm, candidatesQualified, prospectsCreated, stoppedReason },
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
