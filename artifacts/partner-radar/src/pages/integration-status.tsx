import React from 'react';
import { useGetIntegrationsStatus } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, Unplug, Database, Sparkles } from 'lucide-react';
import { format } from 'date-fns';

const ICONS: Record<string, React.ElementType> = {
  hubspot: Database,
  ai_scanner: Sparkles,
};

export default function IntegrationStatus() {
  const { data, isLoading } = useGetIntegrationsStatus();

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integration status</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Phase 0 integrations run in mock mode — no live third-party API calls are made yet, but the
          connection state below reflects real activity recorded in Partner Radar.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          {data?.integrations.map((integration) => {
            const Icon = ICONS[integration.id] ?? Unplug;
            return (
              <Card key={integration.id} className="shadow-none border-border/60">
                <CardHeader className="flex flex-row items-start justify-between py-4 px-5 border-b border-border/50 bg-muted/20 space-y-0">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base font-medium">{integration.name}</CardTitle>
                      <p className="text-xs text-muted-foreground mt-0.5">{integration.description}</p>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      integration.connected
                        ? 'text-emerald-700 bg-emerald-50 border-emerald-200 font-normal shrink-0'
                        : 'text-muted-foreground font-normal shrink-0'
                    }
                  >
                    {integration.connected ? (
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Connected
                      </span>
                    ) : (
                      'Not connected'
                    )}
                  </Badge>
                </CardHeader>
                <CardContent className="p-5 grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Mode</p>
                    <p className="text-sm font-medium mt-1 capitalize">{integration.mode}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Records synced</p>
                    <p className="text-sm font-medium mt-1 tabular-nums">{integration.records_synced}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Last sync</p>
                    <p className="text-sm font-medium mt-1">
                      {integration.last_sync_at ? format(new Date(integration.last_sync_at), 'MMM d, HH:mm') : 'Never'}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
