// Stage 6.4 PAM Workspace Copilot: a small, maintained manifest of what the
// app actually does today, so how-to answers are grounded in real routes and
// actions -- never in the model's memory of "how apps like this usually
// work." Keep this in sync with App.tsx's routes and each page's real
// controls; it is deliberately structured data, not a help-center content
// project (see the 6.4 product spec, section 5).

export interface AppGuideEntry {
  key: string;
  title: string;
  route: string;
  purpose: string;
  actions: string[];
  // Deterministic keyword matching only (getAppGuideContext below) -- no
  // fuzzy/AI classification of which guide sections are relevant.
  keywords: string[];
}

export const APP_GUIDE: AppGuideEntry[] = [
  {
    key: "overview",
    title: "Overview",
    route: "/",
    purpose:
      "Cross-territory KPI dashboard: partner development, weekly commercial, and weekly marketing metrics for a selected period, plus the AI Channel Brief.",
    actions: [
      "View KPI cards for the selected period",
      "Open a KPI's detail drawer for its full breakdown",
      "Generate the AI Channel Brief",
      "Export the quarterly PPTX report",
    ],
    keywords: ["overview", "dashboard", "kpi", "brief", "export", "pptx", "report"],
  },
  {
    key: "discovery",
    title: "Discovery",
    route: "/new-partners",
    purpose:
      "Find and qualify potential new partners. Discovery prospects are AI-qualified candidates from a web search scan, not yet part of the recruitment process.",
    actions: [
      "Run a Discovery scan for your territory",
      "Review a prospect's priority (A/B) and rationale",
      "Accept a prospect into Recruitment",
      "Reject or defer a prospect",
    ],
    keywords: ["discovery", "new partner", "prospect", "scan", "qualify", "priority"],
  },
  {
    key: "recruitment",
    title: "Recruitment",
    route: "/recruitment",
    purpose:
      "Manage the acquisition process after a prospect is accepted: Accepted -> Contacting -> Engaged -> Agreement -> Signed. Signed is a recruitment outcome that contributes to the Signed Partners KPI.",
    actions: [
      "Move a recruitment to its next stage",
      "Log a next step and follow-up date",
      "Put a recruitment on hold, or mark it not pursuing",
      "Review a recruitment's stage history",
    ],
    keywords: ["recruitment", "stage", "contacting", "engaged", "agreement", "signed", "move", "status", "pipeline", "update recruitment"],
  },
  {
    key: "portfolio",
    title: "Portfolio",
    route: "/portfolio",
    purpose:
      "The canonical ongoing partner relationship, created after signing, PAM import, or manual add. Tracks status, activity history, and next actions -- distinct from Marketing Activities.",
    actions: [
      "Log a relationship activity (meeting, call, email) on a partner",
      "Update a relationship's status (active / dormant / closed)",
      "Set a next action and due date",
      "Add a partner manually",
    ],
    keywords: ["portfolio", "partner", "relationship", "meeting", "log a meeting", "activity", "status", "next action"],
  },
  {
    key: "import_book",
    title: "Import my partner book",
    route: "/portfolio/import",
    purpose:
      "Bulk-ingest an existing partner portfolio (e.g. a spreadsheet of partners you already work with) directly into Portfolio. This is existing-partner ingestion -- it does not count as newly signed partner acquisition.",
    actions: [
      "Upload a partner book file",
      "Review matched-vs-new companies before confirming",
      "Confirm the import into Portfolio",
    ],
    keywords: ["import", "partner book", "upload", "bulk", "csv", "spreadsheet"],
  },
  {
    key: "channel_radar",
    title: "Channel Radar",
    route: "/channel-radar",
    purpose:
      "External ecosystem, competitor, and partner-move intelligence, scoped to your territory's geography -- not partner discovery itself. Surfaces signals like acquisitions, partnerships, and expansions.",
    actions: [
      "Run a Radar scan for your territory",
      "Review a signal's implication (opportunity/threat/neutral) and recommended action",
      "Mark a signal reviewed or dismissed",
    ],
    keywords: ["radar", "signal", "competitor", "acquisition", "ecosystem", "threat", "opportunity", "channel radar"],
  },
  {
    key: "team_targets",
    title: "Team Targets",
    route: "/team-targets",
    purpose:
      "Head of Channels' view of every PAM's targets vs. actuals across territories, for the targetable metrics (New Partner Prospects, Signed Partners).",
    actions: ["Set or edit a PAM's target for a period", "Compare progress across the team"],
    keywords: ["team targets", "targets", "team performance"],
  },
  {
    key: "my_workspace",
    title: "My workspace / My Targets",
    route: "/my-workspace",
    purpose: "A PAM's own targets, new-partner prospects, and marketing activities for their territory, in one place.",
    actions: ["View your target vs. actual for the selected period", "Switch the reporting year/quarter"],
    keywords: ["my targets", "my workspace", "see my target", "where are my targets"],
  },
  {
    key: "marketing_activities",
    title: "Marketing Activities",
    route: "/activities",
    purpose:
      "The campaign/marketing activity log (joint campaigns, events, webinars) -- distinct from a Portfolio relationship's own activity history.",
    actions: ["Log a joint campaign, event, or webinar", "Track MQLs and partner referrals"],
    keywords: ["marketing activities", "campaign", "event", "webinar", "mql"],
  },
  {
    key: "search",
    title: "Search",
    route: "*",
    purpose:
      "Global search across Companies, Portfolio, Recruitment, Discovery, and Channel Radar, from the header search control (or Cmd/Ctrl+K).",
    actions: ["Search for a company or partner by name", "Jump to the matching module from the results"],
    keywords: ["search", "find", "look up", "cmd+k"],
  },
  {
    key: "settings",
    title: "Settings",
    route: "/settings",
    purpose:
      "Admin/Head of Channels area for connections, metric mappings, and team administration. Most PAMs will not have access; the Channel Radar lookback period setting lives here for context.",
    actions: [],
    keywords: ["settings", "admin", "connections"],
  },
];

// Deterministic keyword scoring -- no AI classification of "which guide
// section is this about." A question that matches nothing returns the full
// guide (still small/bounded) rather than an empty context, since the
// Copilot must still be able to say "that doesn't exist" for an
// out-of-scope how-to question.
export function getAppGuideContext(query: string): AppGuideEntry[] {
  const q = query.toLowerCase();
  const matched = APP_GUIDE.filter((entry) => entry.keywords.some((k) => q.includes(k)) || q.includes(entry.title.toLowerCase()));
  return matched.length > 0 ? matched : APP_GUIDE;
}
