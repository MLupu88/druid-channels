// Phase 11.2: shared sub-navigation definitions for the Partners and
// Reporting workspaces. Discovery/Recruitment/Portfolio/Activities are one
// partner lifecycle, split across several existing routes -- this list
// describes how those routes present as tabs, without moving, renaming, or
// merging the routes themselves. See components/workspace-subnav.tsx for
// how it's rendered.

export interface WorkspaceSubNavItem {
  value: string;
  label: string;
  href: string;
}

export function getPartnersSubNavItems(isGlobalUser: boolean): WorkspaceSubNavItem[] {
  return [
    // Single shared route (App.tsx: <Route path="/new-partners">
    // {isGlobalUser ? <Prospects /> : <MyProspects />}</Route>) -- only the
    // label and rendered component differ by role, never the URL.
    { value: 'discovery', label: isGlobalUser ? 'Discovery' : 'My Prospects', href: '/new-partners' },
    { value: 'recruitment', label: 'Recruitment', href: '/recruitment' },
    { value: 'portfolio', label: 'Portfolio', href: '/portfolio' },
    { value: 'activities', label: 'Activities', href: '/activities' },
  ];
}

// Global-only: Weekly Team, Team Targets, and PAMs are all Head/Admin-scoped
// routes (see App.tsx's Guarded wrappers) and together form one reporting/
// team-oversight workspace, not a lifecycle. Phase 11.6.1: Weekly Team has
// its own real route (/weekly-team, see pages/weekly-team.tsx) -- it no
// longer lives inside Overview behind a ?view= query param, so Reporting
// and Overview stay cleanly separate top-level areas both visually and in
// URL/navigation semantics.
export const REPORTING_SUBNAV_ITEMS: WorkspaceSubNavItem[] = [
  { value: 'weekly-team', label: 'Weekly Team', href: '/weekly-team' },
  { value: 'team-targets', label: 'Team Targets', href: '/team-targets' },
  { value: 'pams', label: 'PAMs', href: '/pams' },
];
