// 5B-R hotfix (superseded in part by Phase 10, see below): Run Radar
// visibility/state for Channel Radar. Previously the button was omitted
// from the DOM entirely whenever a global user (Head/Admin) had "All
// territories" selected, so the action appeared to vanish with no
// explanation -- it must always be visible for a global user, disabled
// with a reason, only while there's no single territory to run against.
//
// Phase 10 authorization model change: triggering a Radar run spends paid
// Search/AI provider credits, and PAM Radar access is now read-only-only
// (see routes/channel_radar.ts) -- a PAM must never see this action at
// all, not even disabled. Backend authorization is unaffected either way:
// this only controls whether the client offers the action, never whether
// the server accepts it (POST /channel-radar/run stays requireAdmin
// regardless of what the client renders).
export interface RunRadarButtonState {
  visible: boolean;
  disabled: boolean;
  title?: string;
}

export function computeRunRadarButtonState(params: {
  isGlobalUser: boolean;
  territory: string;
  runTargetTerritoryId: string | null;
  isPending: boolean;
}): RunRadarButtonState {
  const { isGlobalUser, territory, runTargetTerritoryId, isPending } = params;

  if (!isGlobalUser) {
    // Phase 10: a PAM can never trigger research, regardless of territory
    // ownership -- never visible, not even disabled-with-an-explanation.
    return { visible: false, disabled: true };
  }
  if (territory === 'all') {
    return { visible: true, disabled: true, title: 'Select a specific territory to run Radar' };
  }
  if (!runTargetTerritoryId) {
    return { visible: true, disabled: true, title: 'Select a territory to run Radar' };
  }
  return { visible: true, disabled: isPending, title: undefined };
}
