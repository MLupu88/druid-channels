import React, { useState, useEffect } from 'react';
import {
  useListUsers,
  useListTerritories,
  useCreateUser,
  useUpdateUser,
  useResetUserPassword,
  useUpdateTerritory,
  useListScanConfigs,
  useGetScanConfig,
  useUpdateScanConfig,
  useListConnections,
  useTestConnection,
  useListMetricMappings,
  useUpsertMetricMapping,
  usePreviewMetricMapping,
  useListManualMetricValues,
  useUpsertManualMetricValue,
  getListUsersQueryKey,
  getListTerritoriesQueryKey,
  getListScanConfigsQueryKey,
  getGetScanConfigQueryKey,
  getListConnectionsQueryKey,
  getListMetricMappingsQueryKey,
  getListManualMetricValuesQueryKey,
  SourceType,
} from '@workspace/api-client-react';
import type { Connection, MetricMapping, KpiDetail } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import {
  Pencil, Save, Database, Sparkles, Unplug, CheckCircle2, Search, Bot, Loader2, XCircle, Eye,
  Plus, MoreHorizontal, KeyRound, UserX, UserCheck, Copy,
} from 'lucide-react';
import {
  Textarea,
} from '@/components/ui/textarea';
import { format } from 'date-fns';
import type { User } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import AccessDenied from '@/pages/access-denied';

const SIGNAL_OPTIONS = [
  { id: 'new_partners', label: 'New partner prospects' },
  { id: 'rfps', label: 'RFPs / tenders' },
  { id: 'events', label: 'Events' },
  { id: 'ai_moves', label: 'AI moves & investments' },
  { id: 'customer_wins', label: 'Customer wins' },
  { id: 'partnerships', label: 'Partnership announcements' },
];

function generateClientPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Fluent-style right-side drawer for adding a PAM or editing an existing one's name/territory. */
function PamFormDrawer({
  user,
  territories,
  onClose,
}: {
  user: User | null; // null => create mode
  territories: { id: string; name: string }[] | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEdit = !!user;

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState('');
  const [territory, setTerritory] = useState(user?.territory ?? '');
  const [password, setPassword] = useState('');

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });

  const createMutation = useCreateUser({
    mutation: {
      onSuccess: (created) => {
        invalidateUsers();
        toast({ title: 'PAM added', description: `${created.name} can now log in with the credential you set.` });
        onClose();
      },
      onError: (err: any) => {
        toast({ title: 'Could not add PAM', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const updateMutation = useUpdateUser({
    mutation: {
      onSuccess: () => {
        invalidateUsers();
        toast({ title: 'PAM updated' });
        onClose();
      },
      onError: (err: any) => {
        toast({ title: 'Could not update PAM', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const pending = createMutation.isPending || updateMutation.isPending;
  const canSubmit = isEdit
    ? name.trim().length > 0
    : name.trim().length > 0 && email.trim().length > 0 && password.length >= 16;

  const handleSubmit = () => {
    if (isEdit && user) {
      updateMutation.mutate({ id: user.id, data: { name: name.trim(), territory: territory || null } });
    } else {
      createMutation.mutate({
        data: { name: name.trim(), email: email.trim(), territory: territory || null, password },
      });
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-[420px] flex flex-col gap-0">
        <SheetHeader>
          <SheetTitle>{isEdit ? `Edit ${user!.name}` : 'Add PAM'}</SheetTitle>
          <SheetDescription>
            {isEdit ? 'Update name or territory.' : 'Create a Partner Alliance Manager account. Role is always PAM.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>

          <div className="space-y-2">
            <Label>Email</Label>
            {isEdit ? (
              <Input value={user!.email} disabled />
            ) : (
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@druidai.com" />
            )}
          </div>

          <div className="space-y-2">
            <Label>Territory</Label>
            <Select value={territory} onValueChange={setTerritory}>
              <SelectTrigger><SelectValue placeholder="No territory" /></SelectTrigger>
              <SelectContent>
                {territories?.map((t) => (
                  <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isEdit && (
            <div className="space-y-2">
              <Label>Initial password</Label>
              <div className="flex gap-2">
                <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 16 characters" />
                <Button type="button" variant="outline" onClick={() => setPassword(generateClientPassword())}>
                  Generate
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Share this with the PAM securely -- it won't be shown again after you close this panel.
              </p>
            </div>
          )}
        </div>

        <SheetFooter className="pt-4 border-t border-border/50">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || pending}>
            {isEdit ? 'Save changes' : 'Add PAM'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DeactivateConfirmDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateMutation = useUpdateUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast({ title: `${user.name} deactivated`, description: 'They can no longer log in.' });
        onClose();
      },
      onError: (err: any) => {
        toast({ title: 'Could not deactivate PAM', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Deactivate {user.name}?</DialogTitle>
          <DialogDescription>
            They will immediately lose access and won't be able to log in until reactivated.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={updateMutation.isPending}
            onClick={() => updateMutation.mutate({ id: user.id, data: { active: false } })}
          >
            Deactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetAccessDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const { toast } = useToast();
  const [revealed, setRevealed] = useState<string | null>(null);

  const resetMutation = useResetUserPassword({
    mutation: {
      onSuccess: (result) => {
        setRevealed(result.temporary_password);
      },
      onError: (err: any) => {
        toast({ title: 'Could not reset access', description: err?.message ?? 'Unknown error', variant: 'destructive' });
        onClose();
      },
    },
  });

  const handleCopy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      toast({ description: 'Temporary password copied' });
    } catch {
      /* clipboard may be unavailable; the value is still visible on screen */
    }
  };

  if (revealed) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Temporary password for {user.name}</DialogTitle>
            <DialogDescription>
              Share this with {user.name} securely. It will not be shown again -- their old password no longer works.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
            <code className="flex-1 text-sm font-mono break-all">{revealed}</code>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleCopy}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Reset access for {user.name}?</DialogTitle>
          <DialogDescription>
            This generates a new temporary password and immediately invalidates their current one.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={resetMutation.isPending} onClick={() => resetMutation.mutate({ id: user.id })}>
            Reset access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: users, isLoading: usersLoading } = useListUsers();
  const { data: territories, isLoading: territoriesLoading } = useListTerritories();

  const [pamForm, setPamForm] = useState<
    { mode: 'create' } | { mode: 'edit'; user: User } | null
  >(null);

  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null);
  const [resetTarget, setResetTarget] = useState<User | null>(null);

  const [editingTerritoryId, setEditingTerritoryId] = useState<string | null>(null);
  const [territoryName, setTerritoryName] = useState('');
  const [territoryOwner, setTerritoryOwner] = useState('');

  const activateMutation = useUpdateUser({
    mutation: {
      onSuccess: (updated) => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast({ title: `${updated.name} activated` });
      },
      onError: (err: any) => {
        toast({ title: 'Could not activate PAM', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const updateTerritoryMutation = useUpdateTerritory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTerritoriesQueryKey() });
        setEditingTerritoryId(null);
        toast({ title: 'Territory updated' });
      },
    },
  });

  const territoryById = new Map(territories?.map((t) => [t.id, t]));
  const openTerritoryEdit = (id: string) => {
    const t = territoryById.get(id);
    if (!t) return;
    setEditingTerritoryId(id);
    setTerritoryName(t.name);
    setTerritoryOwner(t.owner_user_id || '');
  };

  const saveTerritory = () => {
    if (!editingTerritoryId) return;
    updateTerritoryMutation.mutate({
      id: editingTerritoryId,
      data: {
        name: territoryName,
        owner_user_id: territoryOwner || null,
      },
    });
  };

  return (
    <div className="space-y-8">
      <div className="border border-border/60 rounded-md bg-card">
        <div className="p-4 border-b border-border/50 bg-muted/20 flex items-center justify-between">
          <h3 className="font-medium text-sm">Users</h3>
          <Button size="sm" onClick={() => setPamForm({ mode: 'create' })} data-testid="button-add-pam">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add PAM
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Territory</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usersLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : (
              users?.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell className="text-muted-foreground">{user.email}</TableCell>
                  <TableCell className="capitalize">{user.role.replace(/_/g, ' ')}</TableCell>
                  <TableCell className="text-muted-foreground">{user.territory || '-'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={user.active ? 'text-emerald-700 bg-emerald-50 border-emerald-200 font-normal' : 'text-muted-foreground font-normal'}>
                      {user.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {user.role === 'pam' && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-pam-menu-${user.id}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => setPamForm({ mode: 'edit', user })}>
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setResetTarget(user)}>
                            <KeyRound className="h-3.5 w-3.5 mr-2" /> Reset access
                          </DropdownMenuItem>
                          {user.active ? (
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeactivateTarget(user)}>
                              <UserX className="h-3.5 w-3.5 mr-2" /> Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => activateMutation.mutate({ id: user.id, data: { active: true } })}>
                              <UserCheck className="h-3.5 w-3.5 mr-2" /> Activate
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="border border-border/60 rounded-md bg-card">
        <div className="p-4 border-b border-border/50 bg-muted/20">
          <h3 className="font-medium text-sm">Territories</h3>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Countries</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {territoriesLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : (
              territories?.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {users?.find((u) => u.id === t.owner_user_id)?.name || 'Unassigned'}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{t.countries.join(', ')}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openTerritoryEdit(t.id)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pamForm && (
        <PamFormDrawer
          user={pamForm.mode === 'edit' ? pamForm.user : null}
          territories={territories}
          onClose={() => setPamForm(null)}
        />
      )}
      {deactivateTarget && (
        <DeactivateConfirmDialog user={deactivateTarget} onClose={() => setDeactivateTarget(null)} />
      )}
      {resetTarget && (
        <ResetAccessDialog user={resetTarget} onClose={() => setResetTarget(null)} />
      )}

      <Dialog open={!!editingTerritoryId} onOpenChange={(open) => !open && setEditingTerritoryId(null)}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Edit territory</DialogTitle>
            <DialogDescription>Update the territory name or its assigned owner.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={territoryName} onChange={(e) => setTerritoryName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Owner</Label>
              <Select value={territoryOwner} onValueChange={setTerritoryOwner}>
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  {users?.map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingTerritoryId(null)}>Cancel</Button>
            <Button onClick={saveTerritory} disabled={updateTerritoryMutation.isPending}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WhatToLookForTab() {
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
        toast({ title: 'Preferences saved' });
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
      setLocalConfig(JSON.parse(JSON.stringify(detail)));
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

  const handleArrayChange = (field: string, val: string) => {
    setLocalConfig((prev: any) => ({
      ...prev,
      [field]: val.split(',').map(s => s.trim()).filter(Boolean)
    }));
  };

  return (
    <div className="flex gap-6">
      <div className="w-56 shrink-0">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Territory</div>
        <div className="space-y-1">
          {isConfigsLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)
          ) : (
            configs?.map(config => (
              <button
                key={config.id}
                onClick={() => setSelectedId(config.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${selectedId === config.id ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted text-foreground/80'}`}
              >
                {config.territory_name}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 space-y-6">
        {isDetailLoading || !localConfig ? (
          <div className="space-y-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">What to look for</CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-5">
                <div className="grid grid-cols-2 gap-2">
                  {SIGNAL_OPTIONS.map(opt => {
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

            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">Market focus</CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-5">
                <div className="grid grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <Label>Partner types (comma separated)</Label>
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
                  <Label>Technologies / adjacencies (comma separated)</Label>
                  <Input
                    value={localConfig.technologies?.join(', ') || ''}
                    onChange={e => handleArrayChange('technologies', e.target.value)}
                    placeholder="e.g. Microsoft 365, Azure, SAP"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Excluded domains (comma separated)</Label>
                  <Input
                    value={localConfig.excluded_domains?.join(', ') || ''}
                    onChange={e => handleArrayChange('excluded_domains', e.target.value)}
                    placeholder="e.g. microsoft.com, amazon.com"
                  />
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={updateMutation.isPending}>
                <Save className="h-4 w-4 mr-2" />
                Save preferences
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const CONNECTION_ICONS: Record<string, React.ElementType> = {
  hubspot: Database,
  web_search: Search,
  web_reader: Sparkles,
  ai: Bot,
};

function ConnectionStatusBadge({ status }: { status: string }) {
  if (status === 'connected') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal shrink-0"><span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Connected</span></Badge>;
  if (status === 'unverified') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal shrink-0"><span className="flex items-center gap-1"><Eye className="h-3 w-3" /> Credential set (unverified)</span></Badge>;
  if (status === 'error') return <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal shrink-0"><span className="flex items-center gap-1"><XCircle className="h-3 w-3" /> Error</span></Badge>;
  return <Badge variant="outline" className="text-muted-foreground font-normal shrink-0">Not connected</Badge>;
}

function DataStatusPill({ status }: { status: string }) {
  if (status === 'CONNECTED') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal">Connected</Badge>;
  if (status === 'MANUAL') return <Badge variant="outline" className="text-sky-700 bg-sky-50 border-sky-200 font-normal">Manual</Badge>;
  if (status === 'DEMO') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal">Demo data</Badge>;
  return <Badge variant="outline" className="text-muted-foreground font-normal">Not connected</Badge>;
}

function ConnectionCard({ connection }: { connection: Connection }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const Icon = CONNECTION_ICONS[connection.provider_type] ?? Unplug;

  const testMutation = useTestConnection({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListConnectionsQueryKey() });
        const ok = result.status === 'connected' || result.status === 'unverified';
        toast({
          title: ok ? 'Test complete' : 'Connection failed',
          description: result.last_error ?? undefined,
          variant: ok ? 'default' : 'destructive',
        });
      },
      onError: (err: any) => {
        toast({ title: 'Test failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  return (
    <Card className="shadow-none border-border/60">
      <CardHeader className="flex flex-row items-start justify-between py-4 px-5 border-b border-border/50 bg-muted/20 space-y-0">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base font-medium">{connection.provider_name}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Credential: <code className="text-[11px]">{connection.credential_env_var}</code>
              {connection.has_credential ? ' (set)' : ' (not set)'}
            </p>
          </div>
        </div>
        <ConnectionStatusBadge status={connection.status} />
      </CardHeader>
      <CardContent className="p-5 flex items-center justify-between gap-4">
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            <span className="font-medium text-foreground">Last tested: </span>
            {connection.last_tested_at ? format(new Date(connection.last_tested_at), 'MMM d, HH:mm') : 'Never'}
          </p>
          {connection.last_error && (
            <p className="text-rose-600">{connection.last_error}</p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={testMutation.isPending}
          onClick={() => testMutation.mutate({ id: connection.id })}
        >
          {testMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
          Test connection
        </Button>
      </CardContent>
    </Card>
  );
}

function MetricMappingDrawer({ mapping, onClose }: { mapping: MetricMapping; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: connections } = useListConnections();

  const [sourceType, setSourceType] = useState<string>(mapping.source_type);
  const [connectionId, setConnectionId] = useState<string>(mapping.connection_id ?? '');
  const [mappingJsonText, setMappingJsonText] = useState<string>(
    mapping.mapping_json ? JSON.stringify(mapping.mapping_json, null, 2) : ''
  );
  const [active, setActive] = useState(mapping.active);
  const [preview, setPreview] = useState<KpiDetail | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const [manualCurrent, setManualCurrent] = useState('');
  const [manualTarget, setManualTarget] = useState('');
  const [manualNote, setManualNote] = useState('');

  const parseMappingJson = (): { ok: boolean; value: any } => {
    if (!mappingJsonText.trim()) return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(mappingJsonText) };
    } catch {
      setJsonError('Invalid JSON');
      return { ok: false, value: null };
    }
  };

  const previewMutation = usePreviewMetricMapping({
    mutation: {
      onSuccess: (result) => {
        setPreview(result);
        setJsonError(null);
      },
      onError: (err: any) => {
        toast({ title: 'Preview failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const saveMutation = useUpsertMetricMapping({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMetricMappingsQueryKey() });
        toast({ title: 'Mapping saved' });
        onClose();
      },
      onError: (err: any) => {
        toast({ title: 'Save failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const manualMutation = useUpsertManualMetricValue({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListManualMetricValuesQueryKey() });
        toast({ title: 'Manual value saved' });
      },
      onError: (err: any) => {
        toast({ title: 'Save failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const handlePreview = () => {
    const parsed = parseMappingJson();
    if (!parsed.ok) return;
    previewMutation.mutate({
      metricKey: mapping.metric_key,
      data: {
        source_type: sourceType as any,
        connection_id: connectionId || null,
        mapping_json: parsed.value,
        active,
        period: 'q3',
      },
    });
  };

  const handleSave = () => {
    const parsed = parseMappingJson();
    if (!parsed.ok) return;
    saveMutation.mutate({
      metricKey: mapping.metric_key,
      data: {
        source_type: sourceType as any,
        connection_id: connectionId || null,
        mapping_json: parsed.value,
        active,
      },
    });
  };

  const relevantConnections = connections?.filter((c) => {
    if (sourceType === 'HUBSPOT') return c.provider_type === 'hubspot';
    return true;
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{mapping.metric_label}</DialogTitle>
          <DialogDescription>Configure where this metric's value comes from.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2 max-h-[60vh] overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label>Source</Label>
            <Select value={sourceType} onValueChange={setSourceType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={SourceType.PARTNER_RADAR}>Partner Radar (live app data)</SelectItem>
                <SelectItem value={SourceType.ACTIVITIES}>Activities (live app data)</SelectItem>
                <SelectItem value={SourceType.HUBSPOT}>HubSpot</SelectItem>
                <SelectItem value={SourceType.MANUAL}>Manual entry</SelectItem>
                <SelectItem value={SourceType.DEMO}>Demo data</SelectItem>
                <SelectItem value={SourceType.NOT_CONNECTED}>Not connected</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {sourceType === 'HUBSPOT' && (
            <div className="space-y-2">
              <Label>Connection</Label>
              <Select value={connectionId} onValueChange={setConnectionId}>
                <SelectTrigger><SelectValue placeholder="Select a connection" /></SelectTrigger>
                <SelectContent>
                  {relevantConnections?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.provider_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                HubSpot live data requires a credential and is not yet implemented in this environment — metrics
                mapped here will show as "Not connected" until the integration is built.
              </p>
            </div>
          )}

          {sourceType === 'HUBSPOT' && (
            <div className="space-y-2">
              <Label>Mapping (JSON, optional)</Label>
              <Textarea
                rows={4}
                value={mappingJsonText}
                onChange={(e) => setMappingJsonText(e.target.value)}
                placeholder='{"property": "deal_amount"}'
                className="font-mono text-xs"
              />
              {jsonError && <p className="text-xs text-rose-600">{jsonError}</p>}
            </div>
          )}

          <div className="flex items-center justify-between">
            <Label>Active</Label>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>

          {sourceType === 'MANUAL' && (
            <div className="space-y-3 rounded-md border border-border/60 p-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Enter value (Global, current period)</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Current value</Label>
                  <Input value={manualCurrent} onChange={(e) => setManualCurrent(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Target (optional)</Label>
                  <Input value={manualTarget} onChange={(e) => setManualTarget(e.target.value)} placeholder="0" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Note (optional)</Label>
                <Input value={manualNote} onChange={(e) => setManualNote(e.target.value)} placeholder="e.g. from Q3 board deck" />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={manualMutation.isPending || !manualCurrent}
                onClick={() => manualMutation.mutate({
                  data: {
                    metric_key: mapping.metric_key,
                    period: 'q3',
                    territory_id: null,
                    current_value: Number(manualCurrent),
                    target_value: manualTarget ? Number(manualTarget) : null,
                    note: manualNote || null,
                  },
                })}
              >
                Save manual value
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border/50 pt-3">
            <Button variant="outline" size="sm" onClick={handlePreview} disabled={previewMutation.isPending}>
              <Eye className="h-3.5 w-3.5 mr-1.5" />
              Preview
            </Button>
          </div>

          {preview && (
            <div className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">Preview result</span>
                <DataStatusPill status={preview.data_status} />
              </div>
              <p className="text-muted-foreground">Current: <span className="text-foreground font-medium">{preview.current ?? '—'}</span></p>
              <p className="text-muted-foreground text-xs">{preview.explanation}</p>
              {preview.reconciles === false && (
                <p className="text-xs text-rose-600">{preview.reconciliation_note}</p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saveMutation.isPending}>Save mapping</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionsDataTab() {
  const { data: connections, isLoading: connectionsLoading } = useListConnections();
  const { data: mappings, isLoading: mappingsLoading } = useListMetricMappings();
  const [editingMapping, setEditingMapping] = useState<MetricMapping | null>(null);

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h3 className="text-sm font-medium mb-1">Connections</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Credentials are managed as environment variables and never touch the browser. Add the listed
          variable in your environment secrets, then test the connection.
        </p>
        {connectionsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-3">
            {connections?.map((c) => <ConnectionCard key={c.id} connection={c} />)}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium mb-1">Metric setup</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Every Overview KPI is backed by exactly one data source. Metrics without a live connection show
          seeded demo data or a manual value — never fabricated numbers — and are labeled accordingly.
        </p>
        <div className="border border-border/60 rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Metric</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Data status</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappingsLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : (
                mappings?.map((m) => (
                  <TableRow key={m.metric_key}>
                    <TableCell className="font-medium">{m.metric_label}</TableCell>
                    <TableCell className="text-muted-foreground text-sm capitalize">{m.source_type.toLowerCase().replace(/_/g, ' ')}</TableCell>
                    <TableCell><DataStatusPill status={m.current_data_status} /></TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditingMapping(m)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {editingMapping && (
        <MetricMappingDrawer mapping={editingMapping} onClose={() => setEditingMapping(null)} />
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { isGlobalUser } = useAuth();
  if (!isGlobalUser) {
    return <AccessDenied />;
  }
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your team, what Partner Radar looks for, and connected integrations.
        </p>
      </div>

      <Tabs defaultValue="team">
        <TabsList>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="what-to-look-for">What to look for</TabsTrigger>
          <TabsTrigger value="connections">Connections & data</TabsTrigger>
        </TabsList>
        <TabsContent value="team" className="mt-6">
          <TeamTab />
        </TabsContent>
        <TabsContent value="what-to-look-for" className="mt-6">
          <WhatToLookForTab />
        </TabsContent>
        <TabsContent value="connections" className="mt-6">
          <ConnectionsDataTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
