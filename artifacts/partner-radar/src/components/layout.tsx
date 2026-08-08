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
  SidebarSeparator
} from '@/components/ui/sidebar';
import {
  LayoutDashboard,
  Users,
  Briefcase,
  ListOrdered,
  Settings,
  Search,
  HelpCircle,
  ChevronDown,
  Radio,
  LogOut,
  UserCircle
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
import druidLogo from '@/assets/druid-logo.png';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, isGlobalUser, logout } = useAuth();

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').substring(0, 2);
  };

  const navItems: NavItem[] = isGlobalUser
    ? [
        { href: '/', label: 'Overview', icon: LayoutDashboard },
        { href: '/new-partners', label: 'Discovery', icon: Radio },
        { href: '/pams', label: 'PAMs', icon: Users },
        { href: '/activities', label: 'Activities', icon: ListOrdered },
      ]
    : [
        { href: '/', label: 'Overview', icon: LayoutDashboard },
        { href: '/new-partners', label: 'Discovery', icon: Radio },
        { href: '/my-workspace', label: 'My workspace', icon: Briefcase },
        { href: '/activities', label: 'Activities', icon: ListOrdered },
      ];

  return (
    <SidebarProvider>
      <div className="flex min-h-[100dvh] w-full bg-background">
        <Sidebar className="border-r border-border/50">
          <SidebarHeader className="px-4 py-4 flex items-center justify-start gap-2 h-14 border-b border-border/50">
            <img src={druidLogo} alt="DRUID" className="h-5 w-auto shrink-0" />
            <span className="font-semibold text-foreground truncate text-sm">Channels &amp; alliances</span>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navItems.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={location === item.href}>
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
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
                      <SidebarMenuButton asChild isActive={location === '/settings'} className="text-muted-foreground data-[active=true]:text-foreground">
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
          <header className="h-14 flex items-center justify-between border-b border-border/50 bg-card px-6 shrink-0">
            <div className="flex-1 flex items-center max-w-md">
              <div className="relative w-full">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="search"
                  placeholder="Search..."
                  className="h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-4 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </div>

            <div className="flex items-center gap-4 ml-auto">
              <button className="text-muted-foreground hover:text-foreground transition-colors p-2 rounded-md hover:bg-muted" aria-label="Help">
                <HelpCircle className="h-5 w-5" />
              </button>

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
