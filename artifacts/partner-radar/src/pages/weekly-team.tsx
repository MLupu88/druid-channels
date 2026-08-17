import { WeeklyTeamView } from '@/components/weekly-team-view';
import { WorkspaceSubNav } from '@/components/workspace-subnav';
import { REPORTING_SUBNAV_ITEMS } from '@/lib/navigation';

// Phase 11.6.1: Weekly Team's own real Reporting-scoped route
// (/weekly-team), replacing the old `/?view=weekly-team` query param on
// Overview -- see App.tsx (route + Guarded(isGlobalUser), same gate the
// query param used to enforce) and lib/navigation.ts's
// REPORTING_SUBNAV_ITEMS. Renders the existing WeeklyTeamView unchanged;
// this page owns none of its data/business logic, only the Reporting-scoped
// chrome (subnav) around it -- same thin-wrapper pattern as pages/pams.tsx
// and pages/team-targets.tsx.
export default function WeeklyTeam() {
  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        <WorkspaceSubNav items={REPORTING_SUBNAV_ITEMS} />
        <WeeklyTeamView />
      </div>
    </div>
  );
}
