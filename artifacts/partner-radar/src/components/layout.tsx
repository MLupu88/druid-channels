import React from 'react';
import { Link, useLocation } from 'wouter';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger
} from '@/components/ui/sidebar';
import {
  LayoutDashboard,
  Settings,
  ChevronDown,
  Satellite,
  LogOut,
  UserCircle,
  Building2,
  DollarSign,
  ClipboardList
} from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SearchTrigger } from '@/components/search-trigger';
import druidLogo from '@/assets/druid-logo.png';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  // Phase 11.2: additional routes that belong to this workspace but have
  // their own sidebar-less URLs (e.g. Partners' Discovery/Recruitment/
  // Portfolio/Activities tabs) -- highlighted as active without the
  // sidebar itself needing a separate entry per route. Never affects
  // routing/auth, only which nav item is drawn as current.
  activePaths?: string[];
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, isGlobalUser, logout } = useAuth();

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').substring(0, 2);
  };

  // Phase 11.2: Discovery/My Prospects, Recruitment, Portfolio, and
  // Activities are one Partners workspace now (see lib/navigation.ts's
  // getPartnersSubNavItems, rendered as in-page tabs on each of those four
  // pages) -- collapsed here to a single sidebar entry, landing on
  // Portfolio, with the other three routes marked active via activePaths
  // rather than each keeping its own sidebar button. Same treatment for
  // Reporting: Weekly Team, Team Targets, and PAMs (all global-only) don't
  // need independent sidebar entries -- they're reachable from Reporting's
  // own subnav (see REPORTING_SUBNAV_ITEMS) and all three routes are listed
  // in activePaths below so the sidebar stays on "Reporting" for all of
  // them (Phase 11.6.1: Weekly Team moved off Overview's ?view= query
  // param onto its own real /weekly-team route for exactly this reason --
  // a query param on Overview's own "/" could never be distinguished from
  // Overview here).
  const partnersActivePaths = ['/new-partners', '/recruitment', '/portfolio', '/portfolio/import', '/activities'];

  const navItems: NavItem[] = isGlobalUser
    ? [
        { href: '/', label: 'Overview', icon: LayoutDashboard },
        { href: '/portfolio', label: 'Portfolio', icon: Building2, activePaths: partnersActivePaths },
        { href: '/opportunities', label: 'Opportunities', icon: DollarSign },
        { href: '/channel-radar', label: 'Radar', icon: Satellite },
        { href: '/team-targets', label: 'Reporting', icon: ClipboardList, activePaths: ['/weekly-team', '/team-targets', '/pams'] },
      ]
    : [
        // Role-separation hotfix: a PAM is an execution role, not a
        // Discovery operator -- Discovery is replaced by "My Prospects"
        // (same route, a role-conditional component -- see App.tsx).
        // Phase 10: Channel Radar is included here too -- a PAM has
        // read-only access to their own territory's persisted intelligence
        // (see routes/channel_radar.ts); they still cannot configure it,
        // trigger a run, or review/dismiss signals (the page itself hides
        // those controls for a non-global user).
        // Phase 11.2: My Workspace's own summary content is now superseded
        // by Overview (the PAM's operational home) and dropped from the
        // sidebar -- the /my-workspace route itself is untouched and still
        // works if visited directly. My Weekly Report moves into Overview
        // as a tab (see overview.tsx) rather than staying an isolated
        // sidebar item; its route is unchanged too.
        { href: '/', label: 'Overview', icon: LayoutDashboard },
        { href: '/portfolio', label: 'Portfolio', icon: Building2, activePaths: partnersActivePaths },
        { href: '/opportunities', label: 'Opportunities', icon: DollarSign },
        { href: '/channel-radar', label: 'Radar', icon: Satellite },
      ];

  return (
    <SidebarProvider>
      <div className="flex min-h-[100dvh] w-full bg-background">
        {/*
          collapsible="icon": at any desktop width the sidebar can be
          toggled to a narrow icon-only rail (via the SidebarTrigger in the
          header below) instead of ever needing to hide items outright.
          On an actual mobile viewport (see useIsMobile, <768px) the same
          Sidebar component automatically renders as a slide-over Sheet
          drawer instead -- this is shadcn's sidebar primitive's own
          built-in behavior, already imported, just never wired to a
          trigger before now. Every nav item stays reachable at every
          width; only its presentation (label vs. icon+tooltip vs. drawer)
          changes.
        */}
        <Sidebar collapsible="icon" className="border-r border-border/50">
          <SidebarHeader className="px-4 py-4 flex items-center justify-start gap-2 h-14 border-b border-border/50">
            <img src={druidLogo} alt="DRUID" className="h-5 w-auto shrink-0" />
            <span className="font-semibold text-foreground truncate text-sm group-data-[collapsible=icon]:hidden">Channels &amp; alliances</span>
          </SidebarHeader>
          {/* SidebarContent is scrollable by default (overflow-auto in the
              primitive) -- a long, role-filtered nav list never gets
              clipped by the viewport height. */}
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navItems.map((item) => {
                    const isActive = location === item.href || (item.activePaths?.includes(location) ?? false);
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                          <Link href={item.href}>
                            <item.icon />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter>
            <SidebarSeparator className="mb-2" />
            {isGlobalUser && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild isActive={location === '/settings'} tooltip="Admin" className="text-muted-foreground data-[active=true]:text-foreground">
                        <Link href="/settings">
                          <Settings />
                          <span>Admin</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}
          </SidebarFooter>
        </Sidebar>

        <div className="flex flex-col flex-1 min-w-0">
          <header className="h-14 flex items-center gap-3 border-b border-border/50 bg-card px-3 sm:px-6 shrink-0 min-w-0">
            {/* Always visible at every width -- toggles icon-mode on
                desktop, opens the drawer on mobile. This is the one
                control that guarantees the nav is never truly gone, only
                ever collapsed. */}
            <SidebarTrigger />

            <div className="flex-1 min-w-0 flex items-center max-w-md">
              <SearchTrigger />
            </div>

            <div className="flex items-center gap-2 sm:gap-4 shrink-0">
              {user && (
                <DropdownMenu>
                  <DropdownMenuTrigger className="flex items-center gap-2 hover:bg-muted py-1.5 px-2 rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="button-user-menu">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary/10 text-primary text-xs">{getInitials(user.name)}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col items-start text-sm">
                      <span className="font-medium text-foreground leading-none">{user.name}</span>
                      <span className="text-muted-foreground text-xs leading-none mt-1 truncate max-w-[120px]">{user.role.replace(/_/g, ' ')}</span>
                    </div>
                    <ChevronDown className="h-4 w-4 text-muted-foreground ml-1" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">{user.email}</div>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled className="flex items-center gap-2">
                      <UserCircle className="h-4 w-4" />
                      <span>Account</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={logout} className="flex items-center gap-2 cursor-pointer text-rose-600 focus:text-rose-600" data-testid="button-sign-out">
                      <LogOut className="h-4 w-4" />
                      <span>Sign out</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </header>

          <main className="flex-1 overflow-auto bg-background">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
