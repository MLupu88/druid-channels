import { db } from "@workspace/db";
import {
  companiesTable,
  signalsTable,
  prospectsTable,
  prospectActivityTable,
  scanRunsTable,
  scanConfigsTable,
  territoriesTable,
  connectionsTable,
  type ScanConfig,
  type Territory,
} from "@workspace/db";
import { eq, and, ne, inArray } from "drizzle-orm";
import { hasCredential } from "./connections";
import * as searchProvider from "./discoveryProviders/search";
import * as extractionProvider from "./discoveryProviders/extraction";
import * as aiProvider from "./discoveryProviders/ai";

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
  publishedAt: string;
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

function buildSearchQueries(config: ScanConfig): string[] {
  const queries = (config.searchQueries as string[]) ?? [];
  if (queries.length > 0) return queries;
  const technologies = (config.technologies as string[]) ?? [];
  const industries = (config.industries as string[]) ?? [];
  if (technologies.length === 0) return [];
  return technologies.flatMap((tech) => industries.map((industry) => `"${tech} partner" ${industry}`));
}

const REQUIRED_PROVIDER_TYPES = ["web_search", "web_reader", "ai"] as const;

async function attemptLiveDiscovery(config: ScanConfig): Promise<Candidate[] | null> {
  const rows = await db.select().from(connectionsTable).where(inArray(connectionsTable.providerType, REQUIRED_PROVIDER_TYPES));
  const byType = new Map(rows.map((r) => [r.providerType, r]));
  const ready = REQUIRED_PROVIDER_TYPES.every((t) => hasCredential(byType.get(t)?.credentialEnvVar ?? null));
  if (!ready) return null;

  try {
    const candidates: Candidate[] = [];
    for (const query of buildSearchQueries(config)) {
      const results = await searchProvider.search(query, { maxResults: config.maxResults });
      for (const result of results) {
        const domain = extractDomain(result.url);
        const page = await extractionProvider.extract(result.url);
        const qualification = await aiProvider.qualify({
          companyName: result.title,
          domain,
          evidence: [{ url: result.url, text: page.text }],
        });
        candidates.push({
          companyName: result.title,
          domain,
          country: "Unknown",
          partnerType: qualification.partnerType,
          checks: {
            enterpriseAccess: qualification.enterpriseAccess,
            relevantCapability: qualification.relevantCapability,
            technologyAdjacency: qualification.technologyAdjacency,
            partnershipOpenness: qualification.partnershipOpenness,
            recentTrigger: qualification.recentTrigger,
          },
          whyItFits: qualification.whyItFits,
          whyNow: qualification.whyNow,
          suggestedAngle: qualification.suggestedAngle,
          suggestedTargetRole: qualification.suggestedTargetRole,
          signals: qualification.evidenceUrls
            .filter((url) => url === result.url) // never fabricate a source URL outside what was actually given as evidence
            .map((url) => ({
              signalType: "ai_investment" as SignalType,
              title: result.title,
              summary: result.snippet,
              sourceUrl: url,
              sourceDomain: domain,
              publishedAt: result.publishedAt ?? new Date().toISOString().slice(0, 10),
              confidence: "medium" as Confidence,
              rawExcerpt: page.text.slice(0, 400),
            })),
        });
      }
    }
    return candidates;
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

async function upsertCompanyOrSkip(tx: Tx, candidate: Candidate): Promise<string | null> {
  const [existing] = await tx.select().from(companiesTable).where(eq(companiesTable.domain, candidate.domain));
  if (existing) {
    const [activeProspect] = await tx
      .select()
      .from(prospectsTable)
      .where(and(eq(prospectsTable.companyId, existing.id), ne(prospectsTable.status, "rejected")));
    if (activeProspect) return null; // dedupe: an active prospect already exists for this company/domain
    return existing.id;
  }
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

function isExcludedDomain(domain: string, excludedDomains: string[]): boolean {
  return excludedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// Persists one qualified candidate (company + signals + prospect + activity)
// inside a single transaction, so a mid-candidate insert failure can never
// leave a half-created company/prospect behind. Returns whether a new
// prospect was actually created (false on a dedupe skip).
async function persistCandidate(
  candidate: Candidate,
  qualification: QualificationResult,
  territory: Territory,
  dataStatus: "demo" | "connected",
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const companyId = await upsertCompanyOrSkip(tx, candidate);
    if (!companyId) return false;

    await tx.insert(signalsTable).values(candidate.signals.map((s) => ({ companyId, ...s })));

    const [prospect] = await tx
      .insert(prospectsTable)
      .values({
        companyId,
        territoryId: territory.id,
        assignedUserId: territory.ownerUserId,
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
    const liveCandidates = await attemptLiveDiscovery(config);
    const dataStatus: "demo" | "connected" = liveCandidates ? "connected" : "demo";
    const candidates = liveCandidates ?? generateDemoCandidates(config, territory);
    const excludedDomains = (config.excludedDomains as string[]) ?? [];

    let qualifiedCount = 0;
    for (const candidate of candidates) {
      if (isExcludedDomain(candidate.domain, excludedDomains)) continue;
      const qualification = qualifyChecks(candidate.checks, config.minChecksRequired);
      if (!qualification.priority) continue;

      const created = await persistCandidate(candidate, qualification, territory, dataStatus);
      if (created) qualifiedCount++;
    }

    const [completedRun] = await db
      .update(scanRunsTable)
      .set({
        status: "completed",
        completedAt: new Date(),
        resultsFound: candidates.length,
        resultsQualified: qualifiedCount,
        dataStatus,
      })
      .where(eq(scanRunsTable.id, run!.id))
      .returning();

    return { run: completedRun!, prospectsCreated: qualifiedCount };
  } catch (err) {
    await db
      .update(scanRunsTable)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Unknown discovery error",
      })
      .where(eq(scanRunsTable.id, run!.id));
    throw err;
  }
}
