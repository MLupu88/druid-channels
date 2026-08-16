import { db } from "@workspace/db";
import { druidFactsTable, DRUID_FACT_CATEGORIES, type DruidFact } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

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

/**
 * Edits only category/factText/sourceUrl/sourceNote. If the row was
 * verified, this also resets verificationStatus to "unverified" and clears
 * the verifier -- an edited fact always needs re-review, never silently
 * stays trusted.
 */
export async function updateDruidFact(id: string, input: UpdateDruidFactInput, actingUserId: string): Promise<DruidFact | null> {
  if (input.category !== undefined) assertValidCategory(input.category);

  const existing = await getDruidFactById(id);
  if (!existing) return null;

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
