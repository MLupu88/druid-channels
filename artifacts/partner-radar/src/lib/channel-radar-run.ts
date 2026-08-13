// 5B-R hotfix: Run Radar visibility/state for Channel Radar. Previously the
// button was omitted from the DOM entirely whenever a global user (Head/
// Admin) had "All territories" selected, so the action appeared to vanish
// with no explanation. It must always be visible for every user role --
// disabled, with a reason, only while there's no single territory to run
// against. Backend authorization is unaffected: this only controls whether
// the client offers the action, never whether the server accepts it.
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

  if (isGlobalUser && territory === 'all') {
    return { visible: true, disabled: true, title: 'Select a specific territory to run Radar' };
  }
  if (!runTargetTerritoryId) {
    return { visible: true, disabled: true, title: 'Select a territory to run Radar' };
  }
  return { visible: true, disabled: isPending, title: undefined };
}
