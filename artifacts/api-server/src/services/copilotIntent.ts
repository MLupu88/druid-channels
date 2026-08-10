// Stage 6.4 PAM Workspace Copilot: a deliberately tiny, deterministic
// keyword/pattern router -- NOT an AI intent-classification layer (see the
// 6.4 product spec's "Do not build an AI intent-classification layer just
// to decide what context to send"). It only decides whether to send the
// small App Guide context or the bounded operational workspace context; the
// company-specific short-circuit (routes/pam_copilot.ts's
// resolveMentionedCompany call) is layered independently on top of this.
export type CopilotIntent = "how_to" | "operational";

const HOW_TO_PATTERNS: RegExp[] = [
  /\bhow do i\b/,
  /\bhow to\b/,
  /\bhow does\b/,
  /\bwhere do i\b/,
  /\bwhere can i\b/,
  /\bwhere is\b/,
  /\bwhere are\b/,
  /\bwhat is the difference\b/,
  /\bwhat's the difference\b/,
  /\bdifference between\b/,
];

export function classifyIntent(message: string): CopilotIntent {
  const q = message.toLowerCase();
  return HOW_TO_PATTERNS.some((p) => p.test(q)) ? "how_to" : "operational";
}
