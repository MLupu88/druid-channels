import React, { useState, useEffect } from 'react';
import { 
  useListScanConfigs, 
  useGetScanConfig, 
  useUpdateScanConfig,
  useRunScan,
  getListScanConfigsQueryKey,
  getGetScanConfigQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Play, Save, RotateCcw, ShieldAlert, Globe, Crosshair } from 'lucide-react';

export default function ScanSetup() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: configs, isLoading: isConfigsLoading } = useListScanConfigs();
  
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localConfig, setLocalConfig] = useState<any>(null);

  const { data: detail, isLoading: isDetailLoading } = useGetScanConfig(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetScanConfigQueryKey(selectedId || '') } }
  );

  const updateMutation = useUpdateScanConfig({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListScanConfigsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetScanConfigQueryKey(data.id) });
        setLocalConfig(data);
        toast({ title: 'Configuration saved' });
      }
    }
  });

  const runScanMutation = useRunScan({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Test scan started', description: 'Check the prospects list shortly.' });
      }
    }
  });

  useEffect(() => {
    if (configs && configs.length > 0 && !selectedId) {
      setSelectedId(configs[0].id);
    }
  }, [configs, selectedId]);

  useEffect(() => {
    if (detail) {
      setLocalConfig(JSON.parse(JSON.stringify(detail))); // deep copy
    }
  }, [detail]);

  const handleSave = () => {
    if (!selectedId || !localConfig) return;
    updateMutation.mutate({
      id: selectedId,
      data: {
        partner_types: localConfig.partner_types,
        industries: localConfig.industries,
        technologies: localConfig.technologies,
        excluded_domains: localConfig.excluded_domains,
        target_signals: localConfig.target_signals,
        max_results: localConfig.max_results,
        min_checks_required: localConfig.min_checks_required,
        recency_window_days: localConfig.recency_window_days
      }
    });
  };

  const handleRunTest = () => {
    if (!selectedId) return;
    runScanMutation.mutate({
      data: {
        scan_config_id: selectedId,
        mode: 'mock'
      }
    });
  };

  const handleReset = () => {
    if (detail) {
      setLocalConfig(JSON.parse(JSON.stringify(detail)));
    }
  };

  const handleArrayChange = (field: string, val: string) => {
    setLocalConfig((prev: any) => ({
      ...prev,
      [field]: val.split(',').map(s => s.trim()).filter(Boolean)
    }));
  };

  const signalOptions = [
    { id: 'ai_investment', label: 'AI Investment' },
    { id: 'partnership_openness', label: 'Partnership Openness' },
    { id: 'enterprise_access', label: 'Enterprise Customer Access' },
    { id: 'technology_adjacency', label: 'Technology Adjacency' },
    { id: 'hiring', label: 'Hiring' },
    { id: 'events', label: 'Events' },
    { id: 'tenders', label: 'Tenders' },
  ];

  return (
    <div className="flex h-full w-full">
      {/* Left Sidebar */}
      <div className="w-64 border-r border-border/50 bg-card flex flex-col z-10">
        <div className="p-4 border-b border-border/50 font-medium shrink-0">
          Territories
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {isConfigsLoading ? (
              Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)
            ) : (
              configs?.map(config => (
                <button
                  key={config.id}
                  onClick={() => setSelectedId(config.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-colors ${selectedId === config.id ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted text-foreground/80'}`}
                >
                  {config.territory_name}
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right Content */}
      <div className="flex-1 flex flex-col overflow-hidden bg-background">
        <div className="h-16 flex items-center justify-between px-6 border-b border-border/50 bg-card shrink-0">
          <h1 className="text-xl font-semibold tracking-tight">{detail?.name || 'Scan Configuration'}</h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleReset} disabled={updateMutation.isPending || !localConfig}>
              <RotateCcw className="h-4 w-4 mr-2" />
              Reset
            </Button>
            <Button variant="outline" onClick={handleRunTest} disabled={runScanMutation.isPending}>
              <Play className="h-4 w-4 mr-2" />
              Run test scan
            </Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending || !localConfig}>
              <Save className="h-4 w-4 mr-2" />
              Save config
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1">
          {isDetailLoading || !localConfig ? (
            <div className="p-8 space-y-6 max-w-4xl mx-auto">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : (
            <div className="p-8 space-y-8 max-w-4xl mx-auto">
              {/* Market Focus */}
              <Card className="shadow-none border-border/60">
                <CardHeader className="py-4 px-6 border-b border-border/50 bg-muted/20">
                  <div className="flex items-center gap-2">
                    <Globe className="h-5 w-5 text-primary" />
                    <CardTitle className="text-base">Market focus</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="p-6 space-y-6">
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label>Partner Types (comma separated)</Label>
                      <Input 
                        value={localConfig.partner_types?.join(', ') || ''} 
                        onChange={e => handleArrayChange('partner_types', e.target.value)}
                        placeholder="e.g. SI, VAR, Consulting"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Industries (comma separated)</Label>
                      <Input 
                        value={localConfig.industries?.join(', ') || ''} 
                        onChange={e => handleArrayChange('industries', e.target.value)}
                        placeholder="e.g. Finance, Healthcare, Retail"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Technologies / Adjacencies (comma separated)</Label>
                    <Input 
                      value={localConfig.technologies?.join(', ') || ''} 
                      onChange={e => handleArrayChange('technologies', e.target.value)}
                      placeholder="e.g. Microsoft 365, Azure, SAP"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Signals */}
              <Card className="shadow-none border-border/60">
                <CardHeader className="py-4 px-6 border-b border-border/50 bg-muted/20">
                  <div className="flex items-center gap-2">
                    <Crosshair className="h-5 w-5 text-primary" />
                    <CardTitle className="text-base">Target Signals</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="p-6">
                  <div className="grid grid-cols-2 gap-y-4">
                    {signalOptions.map(opt => {
                      const selected: string[] = localConfig.target_signals || [];
                      const checked = selected.includes(opt.id);
                      return (
                        <div key={opt.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={`sig-${opt.id}`}
                            checked={checked}
                            onCheckedChange={(value) => {
                              setLocalConfig((prev: any) => ({
                                ...prev,
                                target_signals: value
                                  ? [...(prev.target_signals || []), opt.id]
                                  : (prev.target_signals || []).filter((s: string) => s !== opt.id),
                              }));
                            }}
                          />
                          <Label htmlFor={`sig-${opt.id}`} className="font-normal cursor-pointer">{opt.label}</Label>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Limits */}
              <Card className="shadow-none border-border/60">
                <CardHeader className="py-4 px-6 border-b border-border/50 bg-muted/20">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-5 w-5 text-primary" />
                    <CardTitle className="text-base">Limits & Constraints</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="p-6 space-y-6">
                  <div className="grid grid-cols-3 gap-6">
                    <div className="space-y-2">
                      <Label>Max candidates per scan</Label>
                      <Input 
                        type="number"
                        value={localConfig.max_results || 50} 
                        onChange={e => setLocalConfig({...localConfig, max_results: parseInt(e.target.value, 10)})}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Min checks required (1-5)</Label>
                      <Input 
                        type="number"
                        min="1" max="5"
                        value={localConfig.min_checks_required || 3} 
                        onChange={e => setLocalConfig({...localConfig, min_checks_required: parseInt(e.target.value, 10)})}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Recency window (days)</Label>
                      <Input 
                        type="number"
                        value={localConfig.recency_window_days || 90} 
                        onChange={e => setLocalConfig({...localConfig, recency_window_days: parseInt(e.target.value, 10)})}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Excluded domains (one per line)</Label>
                    <Textarea 
                      value={localConfig.excluded_domains?.join('\n') || ''} 
                      onChange={e => {
                        setLocalConfig({
                          ...localConfig, 
                          excluded_domains: e.target.value.split('\n').map(s => s.trim()).filter(Boolean)
                        });
                      }}
                      className="font-mono text-sm h-32"
                      placeholder="e.g. microsoft.com&#10;amazon.com"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Search preview */}
              <div className="space-y-3">
                <Label className="text-muted-foreground uppercase tracking-wider text-xs">Generated Search Themes</Label>
                <div className="flex flex-wrap gap-2">
                  {localConfig.search_queries?.map((q: string, i: number) => (
                    <Badge key={i} variant="secondary" className="font-normal py-1 px-3">
                      {q}
                    </Badge>
                  ))}
                  {!localConfig.search_queries?.length && <span className="text-sm text-muted-foreground">No themes generated.</span>}
                </div>
              </div>

            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}