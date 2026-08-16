import { db } from "@workspace/db";
import { druidFactsTable, DRUID_FACT_CATEGORIES, type DruidFact } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

// Transaction-composability pattern reused from discoveryExclusions.ts/
// partnerRelationshipService.ts/territoryOwnership.ts -- lets
// createIngestedDruidFact be composed into a caller's own transaction (see
// druidContextSources.ts's createFactFromSource, which must create the fact
// and update the source's review status atomically).
type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

// Phase 11.5C.1: DRUID Context foundation. A small, admin-curated set of
// facts about DRUID itself (product, positioning, ideal partner profile) --
// deliberately NOT wired into Discovery/Channel Radar qualification yet
// (that's 11.5C.3). Nothing in this file is called from discoveryEngine.ts,
// channelRadarEngine.ts, or either provider module's prompt-building code.

export class DruidFactMissingProvenanceError extends Error {
  constructor() {
    super("A fact cannot be verified without a source URL or a source note.");
    this.name = "DruidFactMissingProvenanceError";
  }
}

// Defense-in-depth, same convention as discoveryExclusions.ts's
// InvalidExclusionReasonError: the HTTP/Zod layer (routes/druid_facts.ts's
// CreateDruidFactBody/UpdateDruidFactBody) already constrains category to
// DRUID_FACT_CATEGORIES, but this is the actual source of truth, not left
// as an HTTP-only rule -- createDruidFact/updateDruidFact must reject an
// invalid category even if called directly, bypassing the route entirely
// (e.g. a future internal caller such as 11.5C.2's ingestion service).
export class InvalidDruidFactCategoryError extends Error {
  constructor(category: string) {
    super(`"${category}" is not a valid DRUID fact category.`);
    this.name = "InvalidDruidFactCategoryError";
  }
}

function assertValidCategory(category: string): void {
  if (!(DRUID_FACT_CATEGORIES as readonly string[]).includes(category)) {
    throw new InvalidDruidFactCategoryError(category);
  }
}

// Phase 11.5C.2 provenance correction: an ingested fact's source_url is
// derived from the druid_context_sources row it was created from
// (createIngestedDruidFact) -- allowing a later generic PATCH to overwrite
// it would decouple the human-visible provenance link from the real
// source_context_id it still points to. Manual facts are unaffected: this
// error is never thrown for sourceType "manual". Idempotently resubmitting
// the exact current value is allowed -- only an actual attempted change is
// rejected, so a client that always round-trips the full record never hits
// this unnecessarily.
export class DruidFactSourceUrlImmutableError extends Error {
  constructor() {
    super("source_url cannot be changed on an ingested fact -- it is derived from the original source and must stay immutable for provenance.");
    this.name = "DruidFactSourceUrlImmutableError";
  }
}

export interface CreateDruidFactInput {
  category: string;
  factText: string;
  sourceUrl?: string | null;
  sourceNote?: string | null;
}

export interface UpdateDruidFactInput {
  category?: string;
  factText?: string;
  sourceUrl?: string | null;
  sourceNote?: string | null;
}

/**
 * Full admin management view -- every row, active or not, verified or not.
 * Distinct on purpose from listTrustedDruidFacts below: an admin managing
 * this store needs to see everything, while any future qualification-
 * grounding read must never see anything but the trusted subset.
 */
export async function listDruidFacts(): Promise<DruidFact[]> {
  return db.select().from(druidFactsTable).orderBy(desc(druidFactsTable.createdAt));
}

/**
 * The one canonical trusted-context read path: active AND verified, nothing
 * else. Established now, ahead of 11.5C.3's actual wiring, so a later slice
 * has exactly one place to read from instead of inventing its own filter
 * (which could accidentally include an inactive or unverified fact). Not
 * called from anywhere in this slice -- no prompt or scoring behavior
 * depends on it yet.
 */
export async function listTrustedDruidFacts(): Promise<DruidFact[]> {
  return db
    .select()
    .from(druidFactsTable)
    .where(and(eq(druidFactsTable.active, true), eq(druidFactsTable.verificationStatus, "verified")))
    .orderBy(desc(druidFactsTable.createdAt));
}

export async function getDruidFactById(id: string): Promise<DruidFact | null> {
  const [row] = await db.select().from(druidFactsTable).where(eq(druidFactsTable.id, id));
  return row ?? null;
}

/**
 * Always creates with sourceType="manual", verificationStatus="unverified",
 * active=true -- these are never accepted from the input type, so there is
 * no code path by which a caller can influence them here.
 */
export async function createDruidFact(input: CreateDruidFactInput, actingUserId: string): Promise<DruidFact> {
  assertValidCategory(input.category);

  const [created] = await db
    .insert(druidFactsTable)
    .values({
      category: input.category as DruidFact["category"],
      factText: input.factText,
      sourceUrl: input.sourceUrl ?? null,
      sourceNote: input.sourceNote ?? null,
      sourceType: "manual",
      verificationStatus: "unverified",
      active: true,
      createdByUserId: actingUserId,
      updatedByUserId: actingUserId,
    })
    .returning();
  return created!;
}

export interface CreateIngestedDruidFactInput {
  category: string;
  factText: string;
  sourceUrl: string;
  sourceContextId: string;
  sourceNote?: string | null;
}

/**
 * Phase 11.5C.2: creates a fact from a reviewed source-material excerpt.
 * sourceType/verificationStatus/active are server-owned exactly like
 * createDruidFact -- sourceType is hardcoded "ingested" (never "manual"),
 * and verificationStatus always starts "unverified": an ingested fact is
 * never automatically trusted. sourceUrl/sourceContextId are supplied by
 * the caller from the persisted druid_context_sources row, never from an
 * HTTP request body directly (see routes/druid_context_sources.ts).
 * Accepts an Executor so druidContextSources.ts's createFactFromSource can
 * compose this into its own transaction alongside the source's review-
 * status update -- if either write fails, both roll back together.
 */
export async function createIngestedDruidFact(
  input: CreateIngestedDruidFactInput,
  actingUserId: string,
  dbHandle: Executor = db,
): Promise<DruidFact> {
  assertValidCategory(input.category);

  const [created] = await dbHandle
    .insert(druidFactsTable)
    .values({
      category: input.category as DruidFact["category"],
      factText: input.factText,
      sourceUrl: input.sourceUrl,
      sourceNote: input.sourceNote ?? null,
      sourceContextId: input.sourceContextId,
      sourceType: "ingested",
      verificationStatus: "unverified",
      active: true,
      createdByUserId: actingUserId,
      updatedByUserId: actingUserId,
    })
    .returning();
  return created!;
}

/**
 * Edits only category/factText/sourceUrl/sourceNote. If the row was
 * verified, this also resets verificationStatus to "unverified" and clears
 * the verifier -- an edited fact always needs re-review, never silently
 * stays trusted.
 *
 * Phase 11.5C.2: sourceUrl is immutable once a fact is ingested (see
 * DruidFactSourceUrlImmutableError) -- manual facts are unaffected, and
 * resubmitting the fact's own current sourceUrl unchanged is always allowed.
 */
export async function updateDruidFact(id: string, input: UpdateDruidFactInput, actingUserId: string): Promise<DruidFact | null> {
  if (input.category !== undefined) assertValidCategory(input.category);

  const existing = await getDruidFactById(id);
  if (!existing) return null;

  if (existing.sourceType === "ingested" && input.sourceUrl !== undefined && input.sourceUrl !== existing.sourceUrl) {
    throw new DruidFactSourceUrlImmutableError();
  }

  const wasVerified = existing.verificationStatus === "verified";

  const [updated] = await db
    .update(druidFactsTable)
    .set({
      ...(input.category !== undefined ? { category: input.category as DruidFact["category"] } : {}),
      ...(input.factText !== undefined ? { factText: input.factText } : {}),
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.sourceNote !== undefined ? { sourceNote: input.sourceNote } : {}),
      ...(wasVerified ? { verificationStatus: "unverified" as const, verifiedByUserId: null, verifiedAt: null } : {}),
      updatedByUserId: actingUserId,
      updatedAt: new Date(),
    })
    .where(eq(druidFactsTable.id, id))
    .returning();
  return updated ?? null;
}

/**
 * Rejects (DruidFactMissingProvenanceError) if the fact has neither a
 * non-empty sourceUrl nor a non-empty sourceNote -- a fact can never become
 * verified DRUID truth with zero provenance. This is the authoritative
 * enforcement point, not merely a UI-side rule.
 */
export async function verifyDruidFact(id: string, actingUserId: string): Promise<DruidFact | null> {
  const existing = await getDruidFactById(id);
  if (!existing) return null;

  const hasProvenance = Boolean(existing.sourceUrl?.trim()) || Boolean(existing.sourceNote?.trim());
  if (!hasProvenance) throw new DruidFactMissingProvenanceError();

  const [updated] = await db
    .update(druidFactsTable)
    .set({
      verificationStatus: "verified",
      verifiedByUserId: actingUserId,
      verifiedAt: new Date(),
      updatedByUserId: actingUserId,
      updatedAt: new Date(),
    })
    .where(eq(druidFactsTable.id, id))
    .returning();
  return updated ?? null;
}

/**
 * Sets active=false and records deactivatedByUserId/deactivatedAt.
 * verificationStatus is deliberately left untouched -- deactivating a
 * verified fact only hides it from listTrustedDruidFacts; re-entry to trust
 * is gated at reactivation instead (see reactivateDruidFact below).
 */
export async function deactivateDruidFact(id: string, actingUserId: string): Promise<DruidFact | null> {
  const [updated] = await db
    .update(druidFactsTable)
    .set({
      active: false,
      deactivatedByUserId: actingUserId,
      deactivatedAt: new Date(),
      updatedByUserId: actingUserId,
      updatedAt: new Date(),
    })
    .where(eq(druidFactsTable.id, id))
    .returning();
  return updated ?? null;
}

/**
 * Sets active=true and clears deactivatedByUserId/deactivatedAt, AND resets
 * verificationStatus to "unverified" (clearing the verifier) -- a
 * reactivated fact is never automatically trusted again, protecting against
 * a stale or intentionally-retired fact silently re-entering trusted DRUID
 * context. An admin must explicitly verify it again.
 */
export async function reactivateDruidFact(id: string, actingUserId: string): Promise<DruidFact | null> {
  const [updated] = await db
    .update(druidFactsTable)
    .set({
      active: true,
      deactivatedByUserId: null,
      deactivatedAt: null,
      verificationStatus: "unverified",
      verifiedByUserId: null,
      verifiedAt: null,
      updatedByUserId: actingUserId,
      updatedAt: new Date(),
    })
    .where(eq(druidFactsTable.id, id))
    .returning();
  return updated ?? null;
}
