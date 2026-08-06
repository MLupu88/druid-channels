import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AppLayout } from '@/components/layout';
import { UserProvider } from '@/contexts/user-context';
import NotFound from '@/pages/not-found';
import Overview from '@/pages/overview';
import Prospects from '@/pages/prospects';
import ScanSetup from '@/pages/scan-setup';
import Campaigns from '@/pages/campaigns';

const queryClient = new QueryClient();

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/prospects" component={Prospects} />
        <Route path="/scan-setup" component={ScanSetup} />
        <Route path="/campaigns" component={Campaigns} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <UserProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster />
        </UserProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;