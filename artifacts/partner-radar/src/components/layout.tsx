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
  Handshake,
  ListOrdered, 
  Settings, 
  Search, 
  HelpCircle,
  ChevronDown,
  Radar
} from 'lucide-react';
import { useUser } from '@/contexts/user-context';
import { useListUsers } from '@workspace/api-client-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { activeUser, setActiveUser } = useUser();
  const { data: users } = useListUsers();

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').substring(0, 2);
  };

  return (
    <SidebarProvider>
      <div className="flex min-h-[100dvh] w-full bg-background">
        <Sidebar className="border-r border-border/50">
          <SidebarHeader className="px-4 py-4 flex items-center justify-start gap-2 h-14 border-b border-border/50">
            <Radar className="h-6 w-6 text-primary shrink-0" />
            <span className="font-semibold text-foreground truncate">DRUID Partner Radar</span>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === '/'}>
                      <Link href="/">
                        <LayoutDashboard />
                        <span>Overview</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === '/new-partners'}>
                      <Link href="/new-partners">
                        <Users />
                        <span>New partners</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === '/partners'}>
                      <Link href="/partners">
                        <Handshake />
                        <span>Partners</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === '/activities'}>
                      <Link href="/activities">
                        <ListOrdered />
                        <span>Activities</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          
          <SidebarFooter>
            <SidebarSeparator className="mb-2" />
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === '/settings'} className="text-muted-foreground data-[active=true]:text-foreground">
                      <Link href="/settings">
                        <Settings />
                        <span>Settings</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
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
              
              {activeUser && (
                <DropdownMenu>
                  <DropdownMenuTrigger className="flex items-center gap-2 hover:bg-muted py-1.5 px-2 rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary/10 text-primary text-xs">{getInitials(activeUser.name)}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col items-start text-sm">
                      <span className="font-medium text-foreground leading-none">{activeUser.name}</span>
                      <span className="text-muted-foreground text-xs leading-none mt-1 truncate max-w-[120px]">{activeUser.role.replace(/_/g, ' ')}</span>
                    </div>
                    <ChevronDown className="h-4 w-4 text-muted-foreground ml-1" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {users?.map(user => (
                      <DropdownMenuItem 
                        key={user.id} 
                        onClick={() => setActiveUser(user)}
                        className={`flex items-center gap-2 cursor-pointer ${activeUser.id === user.id ? 'bg-muted' : ''}`}
                      >
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className="bg-primary/10 text-primary text-[10px]">{getInitials(user.name)}</AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col">
                          <span className="text-sm">{user.name}</span>
                          <span className="text-xs text-muted-foreground">{user.role.replace(/_/g, ' ')}</span>
                        </div>
                      </DropdownMenuItem>
                    ))}
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