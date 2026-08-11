import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, Redirect } from 'wouter';
import { AppLayout } from '@/components/layout';
import { AuthProvider, useAuth } from '@/contexts/auth-context';
import NotFound from '@/pages/not-found';
import AccessDenied from '@/pages/access-denied';
import Login from '@/pages/login';
import Overview from '@/pages/overview';
import Prospects from '@/pages/prospects';
import MyProspects from '@/pages/my-prospects';
import Recruitment from '@/pages/recruitment';
import ChannelRadar from '@/pages/channel-radar';
import Portfolio from '@/pages/portfolio';
import PortfolioImport from '@/pages/portfolio-import';
import TeamTargets from '@/pages/team-targets';
import Pams from '@/pages/pams';
import MyWorkspace from '@/pages/pam-workspace';
import Campaigns from '@/pages/campaigns';
import Settings from '@/pages/settings';
import { Loader2 } from 'lucide-react';

const queryClient = new QueryClient();

function FullScreenLoader() {
  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/** Wraps a page component, rendering AccessDenied when `allow` is false. */
function Guarded({ allow, children }: { allow: boolean; children: React.ReactNode }) {
  if (!allow) return <AccessDenied />;
  return <>{children}</>;
}

function AuthenticatedApp() {
  const { user, isGlobalUser } = useAuth();

  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Overview} />
        {/* Role-separation hotfix: Discovery (run/manage/assign, global pool)
            is Head-of-Channels/Admin-only; a PAM sees "My Prospects" (their
            own assigned rows only) at the same route -- see App-layer nav's
            comment and routes/prospects.ts's assignment-scoping. */}
        <Route path="/new-partners">
          {isGlobalUser ? <Prospects /> : <MyProspects />}
        </Route>
        <Route path="/recruitment" component={Recruitment} />
        <Route path="/channel-radar">
          <Guarded allow={isGlobalUser}><ChannelRadar /></Guarded>
        </Route>
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/portfolio/import" component={PortfolioImport} />
        <Route path="/pams">
          <Guarded allow={isGlobalUser}><Pams /></Guarded>
        </Route>
        <Route path="/team-targets">
          <Guarded allow={isGlobalUser}><TeamTargets /></Guarded>
        </Route>
        <Route path="/my-workspace">
          <Guarded allow={!isGlobalUser}><MyWorkspace /></Guarded>
        </Route>
        <Route path="/activities" component={Campaigns} />
        <Route path="/settings">
          <Guarded allow={isGlobalUser}><Settings /></Guarded>
        </Route>
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function RootRouter() {
  const { user, isLoading } = useAuth();

  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <Switch>
        <Route path="/login">
          {user ? <Redirect to="/" /> : <Login />}
        </Route>
        <Route>
          {isLoading ? (
            <FullScreenLoader />
          ) : user ? (
            <AuthenticatedApp />
          ) : (
            <Redirect to="/login" />
          )}
        </Route>
      </Switch>
    </WouterRouter>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <RootRouter />
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
