import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { territoriesTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
// The component schemas PamCopilotChatBody/PamCopilotChatResponse in
// openapi.yaml only produce TS *types* -- orval's zod generation step names
// each operation's runtime validators after the operationId instead
// (ChatWithPamCopilotBody/ChatWithPamCopilotResponse), exactly like every
// other route in this app (e.g. routes/ai_channel_brief.ts's
// RegenerateAiChannelBriefBody/GetAiChannelBriefResponse for the
// AiChannelBrief-ref'd body/response). These are the real runtime schemas.
import { ChatWithPamCopilotBody, ChatWithPamCopilotResponse } from "@workspace/api-zod";
import { requireAuth } from "../middleware/auth";
import { isGlobalUser, getOwnTerritory } from "../services/authz";
import { resolvePeriodKey } from "../services/kpiRegistry";
import { classifyIntent } from "../services/copilotIntent";
import { getAppGuideContext } from "../services/appGuide";
import { getPamWorkspaceSummary, getPartnerContext, resolveMentionedCompany } from "../services/copilotContextService";
import { chat as chatWithProvider, CopilotNotConfiguredError, CopilotProviderError, type CopilotRequestPayload } from "../services/copilotProvider";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function classifyCopilotError(err: unknown): string {
  if (err instanceof CopilotNotConfiguredError) return "The Copilot's AI provider is not connected. Contact an admin.";
  if (err instanceof CopilotProviderError) return "I couldn't generate an answer right now. Your workspace data is still available; please try again.";
  return "I couldn't generate an answer right now. Your workspace data is still available; please try again.";
}

// Stage 6.4 PAM Workspace Copilot. Read-only: this route never writes to
// the database, and the DeepSeek call it makes (services/copilotProvider.ts)
// is never given SQL access or an unrestricted table -- only the bounded
// JSON assembled below by copilotContextService.ts.
router.post("/pam-copilot/chat", requireAuth, async (req, res): Promise<void> => {
  const parsed = ChatWithPamCopilotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const body = parsed.data;
  const actingUser = req.actingUser!;

  // Authorization: a PAM is always forced to their own identity/territory
  // server-side, exactly like every other PAM-scoped route in this app --
  // a manipulated pam_user_id in the request body is silently ignored, not
  // honored and not even inspected. Head/Admin must explicitly name a PAM
  // to drill into (never a silent fallback to global data for what is
  // inherently a PAM-specific question -- see the 6.4 spec's authz section).
  let pamUserId: string;
  let pamName: string;
  let territoryId: string;
  let territoryName: string;
  let territoryCountries: string[];

  if (isGlobalUser(actingUser)) {
    if (!body.pam_user_id) {
      res.status(400).json({ error: "Specify pam_user_id to use the Copilot for a PAM's workspace." });
      return;
    }
    const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.ownerUserId, body.pam_user_id));
    if (!territory) {
      res.status(404).json({ error: "That PAM has no canonical territory assigned." });
      return;
    }
    const [pam] = await db.select().from(usersTable).where(eq(usersTable.id, body.pam_user_id));
    if (!pam) {
      res.status(404).json({ error: "PAM not found." });
      return;
    }
    pamUserId = pam.id;
    pamName = pam.name;
    territoryId = territory.id;
    territoryName = territory.name;
    territoryCountries = (territory.countries as string[]) ?? [];
  } else {
    const own = await getOwnTerritory(actingUser.id);
    if (!own) {
      res.status(403).json({ error: "Your account has no territory assigned. Contact an admin." });
      return;
    }
    const [territory] = await db.select().from(territoriesTable).where(eq(territoriesTable.id, own.territoryId!));
    pamUserId = actingUser.id;
    pamName = actingUser.name;
    territoryId = own.territoryId!;
    territoryName = own.territoryName;
    territoryCountries = (territory?.countries as string[]) ?? [];
  }

  const periodKey = resolvePeriodKey(body.period);

  // Deterministic company resolution, scoped to the resolved territory only
  // -- never the model guessing a company from a similar name (see the 6.4
  // spec's section 8). Ambiguous/not-found short-circuits here without ever
  // calling the AI provider.
  const companyResolution = await resolveMentionedCompany(body.message, body.company_id ?? null, territoryId);
  if (companyResolution.status === "ambiguous") {
    res.json(
      ChatWithPamCopilotResponse.parse({
        answer: `I found more than one matching company in your workspace: ${companyResolution.matches.join(", ")}. Could you clarify which one you mean?`,
        evidence: [],
        suggested_route: null,
        follow_ups: [],
      }),
    );
    return;
  }
  if (companyResolution.status === "not_found") {
    res.json(
      ChatWithPamCopilotResponse.parse({
        answer: "I couldn't find that company in your authorized workspace.",
        evidence: [],
        suggested_route: null,
        follow_ups: [],
      }),
    );
    return;
  }

  const intent = classifyIntent(body.message);
  let payload: CopilotRequestPayload;

  if (companyResolution.status === "found") {
    const partner = await getPartnerContext(companyResolution.company.id, territoryId);
    payload = { intent: "operational", question: body.message, partner };
  } else if (intent === "how_to") {
    payload = { intent: "how_to", question: body.message, app_guide: getAppGuideContext(body.message) };
  } else {
    const workspace = await getPamWorkspaceSummary(pamUserId, pamName, territoryId, territoryName, territoryCountries, periodKey);
    payload = { intent: "operational", question: body.message, workspace };
  }

  let reply;
  try {
    reply = await chatWithProvider(payload);
  } catch (err) {
    const safeMessage = classifyCopilotError(err);
    logger.error({ errorName: err instanceof Error ? err.name : typeof err, safeMessage }, "PAM Copilot chat failed");
    res.status(502).json({ error: safeMessage });
    return;
  }

  res.json(ChatWithPamCopilotResponse.parse(reply));
});

export default router;
