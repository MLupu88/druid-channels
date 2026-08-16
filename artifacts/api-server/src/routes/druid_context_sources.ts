import { Router, type IRouter } from "express";
import type { DruidContextSource } from "@workspace/db";
import {
  RefreshDruidContextSourcesResponse,
  ListDruidContextSourcesResponse,
  ReviewDruidContextSourceResponse,
  IgnoreDruidContextSourceResponse,
  CreateFactFromDruidContextSourceBody,
  CreateFactFromDruidContextSourceResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middleware/auth";
import {
  refreshDruidContextSources,
  listDruidContextSources,
  markSourceReviewed,
  markSourceIgnored,
  createFactFromSource,
  DruidContextSourceIgnoredError,
  DruidContextSourceInvalidTransitionError,
} from "../services/druidContextSources";
import { DruidContextCrawlNotImplementedError, DruidContextCrawlProviderError } from "../services/druidContextIngestionProvider";
import { InvalidDruidFactCategoryError } from "../services/druidFacts";
import { shapeDruidFact } from "./druid_facts";

// Phase 11.5C.2: admin-only surface for DRUID Context source ingestion
// (druidai.com -> Tavily Crawl -> reviewable source material -> zero or
// more UNVERIFIED druid_facts). Same requireAdmin gate as every other
// Settings-scoped surface. Deliberately does NOT expose normalized_url or
// content_hash -- those are internal matching keys, never part of the wire
// contract (same convention as channel_radar_signal_evidence's
// normalizedUrl never being displayed).
const router: IRouter = Router();

function shapeDruidContextSource(source: DruidContextSource) {
  return {
    id: source.id,
    source_url: source.sourceUrl,
    extracted_text: source.extractedText,
    review_status: source.reviewStatus,
    extracted_at: source.extractedAt.toISOString(),
    last_seen_at: source.lastSeenAt.toISOString(),
    reviewed_by_user_id: source.reviewedByUserId,
    reviewed_at: source.reviewedAt ? source.reviewedAt.toISOString() : null,
  };
}

// Small closed set of internal failure classifications -- never the raw
// provider error text, same convention as connections.ts's classifyTestError.
function classifyCrawlError(err: unknown): string {
  if (err instanceof DruidContextCrawlProviderError) return err.code;
  return "unknown_error";
}

router.post("/druid-context-sources/refresh", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await refreshDruidContextSources();
    res.json(
      RefreshDruidContextSourcesResponse.parse({
        pages_crawled: summary.pagesCrawled,
        new_sources: summary.newSources,
        updated_sources: summary.updatedSources,
      }),
    );
  } catch (err) {
    if (err instanceof DruidContextCrawlNotImplementedError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof DruidContextCrawlProviderError) {
      res.status(502).json({ error: classifyCrawlError(err) });
      return;
    }
    throw err;
  }
});

router.get("/druid-context-sources", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await listDruidContextSources();
  res.json(ListDruidContextSourcesResponse.parse(rows.map(shapeDruidContextSource)));
});

router.post("/druid-context-sources/:id/review", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const updated = await markSourceReviewed(id, req.actingUser!.id);
    if (!updated) {
      res.status(404).json({ error: "DRUID context source not found" });
      return;
    }
    res.json(ReviewDruidContextSourceResponse.parse(shapeDruidContextSource(updated)));
  } catch (err) {
    if (err instanceof DruidContextSourceInvalidTransitionError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/druid-context-sources/:id/ignore", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const updated = await markSourceIgnored(id, req.actingUser!.id);
    if (!updated) {
      res.status(404).json({ error: "DRUID context source not found" });
      return;
    }
    res.json(IgnoreDruidContextSourceResponse.parse(shapeDruidContextSource(updated)));
  } catch (err) {
    if (err instanceof DruidContextSourceInvalidTransitionError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/druid-context-sources/:id/facts", requireAdmin, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = CreateFactFromDruidContextSourceBody.parse(req.body);
  try {
    const fact = await createFactFromSource(
      id,
      { category: body.category, factText: body.fact_text, sourceNote: body.source_note ?? null },
      req.actingUser!.id,
    );
    if (!fact) {
      res.status(404).json({ error: "DRUID context source not found" });
      return;
    }
    res.status(201).json(CreateFactFromDruidContextSourceResponse.parse(shapeDruidFact(fact)));
  } catch (err) {
    if (err instanceof DruidContextSourceIgnoredError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof InvalidDruidFactCategoryError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
