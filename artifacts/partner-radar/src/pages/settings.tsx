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
  useCreateScanConfig,
  useUpdateScanConfig,
  useListChannelRadarConfigs,
  useGetChannelRadarConfig,
  useCreateChannelRadarConfig,
  useUpdateChannelRadarConfig,
  useListConnections,
  useTestConnection,
  useUpdateConnection,
  useSetConnectionSecret,
  useListMetricMappings,
  useUpsertMetricMapping,
  usePreviewMetricMapping,
  useListManualMetricValues,
  useUpsertManualMetricValue,
  useListDiscoveryExclusions,
  useRestoreDiscoveryExclusion,
  getListDiscoveryExclusionsQueryKey,
  useListDruidFacts,
  useCreateDruidFact,
  useUpdateDruidFact,
  useVerifyDruidFact,
  useDeactivateDruidFact,
  useReactivateDruidFact,
  getListDruidFactsQueryKey,
  useListDruidContextSources,
  useRefreshDruidContextSources,
  useReviewDruidContextSource,
  useIgnoreDruidContextSource,
  useCreateFactFromDruidContextSource,
  getListDruidContextSourcesQueryKey,
  getListUsersQueryKey,
  getListTerritoriesQueryKey,
  getListScanConfigsQueryKey,
  getGetScanConfigQueryKey,
  getListChannelRadarConfigsQueryKey,
  getGetChannelRadarConfigQueryKey,
  getListConnectionsQueryKey,
  getListMetricMappingsQueryKey,
  getListManualMetricValuesQueryKey,
  SourceType,
} from '@workspace/api-client-react';
import type { Connection, MetricMapping, KpiDetail, DruidFact, DruidContextSource } from '@workspace/api-client-react';
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
import { sortConnectionsByDisplayOrder, getConnectionTone, isErrorTone } from '@/lib/connection-display';
import { parseMultiValueInput, formatMultiValueInput, parseLineDelimitedInput, formatLineDelimitedInput } from '@/lib/multi-value-input';
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
  territories: { id: string; name: string; owner_user_id?: string | null }[] | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEdit = !!user;

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState('');
  // Canonical territory assignment (territories.owner_user_id), not the
  // free-text users.territory display field -- the UI and the
  // authorization model must not be able to disagree. '__none__' = no
  // change (create: PAM has no territory yet; edit: leave as-is).
  // '__new__' reveals a name field to create a brand-new territory.
  const ownedTerritory = territories?.find((t) => t.owner_user_id === user?.id);
  const [territorySelection, setTerritorySelection] = useState<string>(ownedTerritory?.id ?? '__none__');
  const [newTerritoryName, setNewTerritoryName] = useState('');
  const [password, setPassword] = useState('');
  const [locationLabel, setLocationLabel] = useState(user?.location_label ?? '');
  const [timezone, setTimezone] = useState(user?.timezone ?? '');

  // Standard IANA-validity check (Intl throws on an unrecognized zone) --
  // used both here for inline feedback and server-side before saving.
  const isValidIanaTimezone = (tz: string): boolean => {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  };
  const timezoneError = timezone.trim() && !isValidIanaTimezone(timezone.trim())
    ? 'Not a recognized IANA timezone (e.g. Europe/Bucharest).'
    : null;

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
  const canSubmit = (isEdit
    ? name.trim().length > 0
    : name.trim().length > 0 && email.trim().length > 0 && password.length >= 16
  ) && timezoneError === null && (territorySelection !== '__new__' || newTerritoryName.trim().length > 0);

  // Never both -- resolveTerritoryAssignment server-side rejects that
  // combination anyway, but the UI can't even construct it.
  const territoryFields =
    territorySelection === '__new__'
      ? { new_territory_name: newTerritoryName.trim() || null }
      : territorySelection !== '__none__'
      ? { territory_id: territorySelection }
      : {};

  const handleSubmit = () => {
    if (isEdit && user) {
      updateMutation.mutate({
        id: user.id,
        data: {
          name: name.trim(),
          location_label: locationLabel.trim() || null,
          timezone: timezone.trim() || null,
          ...territoryFields,
        },
      });
    } else {
      createMutation.mutate({
        data: {
          name: name.trim(),
          email: email.trim(),
          location_label: locationLabel.trim() || null,
          timezone: timezone.trim() || null,
          password,
          ...territoryFields,
        },
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
            <Select value={territorySelection} onValueChange={setTerritorySelection}>
              <SelectTrigger><SelectValue placeholder="No territory" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{isEdit ? 'No change' : 'No territory yet'}</SelectItem>
                {territories
                  ?.filter((t) => !t.owner_user_id || t.owner_user_id === user?.id)
                  .map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                <SelectItem value="__new__">+ Create new territory...</SelectItem>
              </SelectContent>
            </Select>
            {territorySelection === '__new__' && (
              <Input value={newTerritoryName} onChange={(e) => setNewTerritoryName(e.target.value)} placeholder="New territory name" className="mt-2" />
            )}
            <p className="text-xs text-muted-foreground">
              One PAM owns one territory -- this is the canonical assignment (territories.owner_user_id), not a display label. Only unowned territories are offered.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Location label</Label>
            <Input value={locationLabel} onChange={(e) => setLocationLabel(e.target.value)} placeholder="e.g. Bucharest, Romania" />
          </div>

          <div className="space-y-2">
            <Label>Timezone (IANA)</Label>
            <Input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="e.g. Europe/Bucharest"
              aria-invalid={timezoneError !== null}
            />
            {timezoneError ? (
              <p className="text-xs text-rose-600">{timezoneError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Both fields are optional. Powers the PAM Local Time clock on Overview -- left blank, no clock is shown.</p>
            )}
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
  const { data: territories } = useListTerritories();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A territory clicked in the left nav that has no scan_config yet -- shows
  // the "Create configuration" CTA instead of the edit form. Mutually
  // exclusive with selectedId (selecting one clears the other).
  const [pendingTerritoryId, setPendingTerritoryId] = useState<string | null>(null);
  const [localConfig, setLocalConfig] = useState<any>(null);
  const [localCountries, setLocalCountries] = useState<string>('');
  // Raw text for each comma/line-delimited field -- kept separate from
  // localConfig so typing never round-trips through split/trim/filter
  // until save (see src/lib/multi-value-input.ts).
  const [localPartnerTypes, setLocalPartnerTypes] = useState<string>('');
  const [localIndustries, setLocalIndustries] = useState<string>('');
  const [localTechnologies, setLocalTechnologies] = useState<string>('');
  const [localExcludedDomains, setLocalExcludedDomains] = useState<string>('');
  const [localSearchQueries, setLocalSearchQueries] = useState<string>('');

  const { data: detail, isLoading: isDetailLoading } = useGetScanConfig(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetScanConfigQueryKey(selectedId || '') } }
  );

  const selectedTerritory = detail ? territories?.find((t) => t.id === detail.territory_id) : undefined;

  // Two canonical stores behind one user-facing "Partner search criteria"
  // save: scan_configs (partner/search/qualification criteria) and
  // territories (geography, never duplicated onto scan_configs). Each
  // mutation only invalidates/refetches its own data on its own success, so
  // a partial failure never leaves stale data displayed as if it saved.
  const updateMutation = useUpdateScanConfig({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListScanConfigsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetScanConfigQueryKey(data.id) });
        setLocalConfig(data);
      },
    },
  });

  const createMutation = useCreateScanConfig({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListScanConfigsQueryKey() });
        setPendingTerritoryId(null);
        setSelectedId(data.id);
        toast({ title: 'Discovery configuration created', description: 'Define partner types, industries, technologies, and target signals below.' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not create configuration', description: err?.message ?? 'Please try again.' });
      },
    },
  });

  const updateTerritoryMutation = useUpdateTerritory({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTerritoriesQueryKey() });
      },
    },
  });

  useEffect(() => {
    if (configs && configs.length > 0 && !selectedId) {
      setSelectedId(configs[0].id);
    }
  }, [configs, selectedId]);

  useEffect(() => {
    if (detail) {
      setLocalConfig(JSON.parse(JSON.stringify(detail)));
      setLocalPartnerTypes(formatMultiValueInput(detail.partner_types));
      setLocalIndustries(formatMultiValueInput(detail.industries));
      setLocalTechnologies(formatMultiValueInput(detail.technologies));
      setLocalExcludedDomains(formatMultiValueInput(detail.excluded_domains));
      setLocalSearchQueries(formatLineDelimitedInput(detail.search_queries));
    }
  }, [detail]);

  useEffect(() => {
    if (selectedTerritory) {
      setLocalCountries((selectedTerritory.countries ?? []).join(', '));
    }
  }, [selectedTerritory]);

  const isSaving = updateMutation.isPending || updateTerritoryMutation.isPending;

  const handleSave = async () => {
    if (!selectedId || !localConfig || isSaving) return;

    try {
      await updateMutation.mutateAsync({
        id: selectedId,
        data: {
          partner_types: parseMultiValueInput(localPartnerTypes),
          industries: parseMultiValueInput(localIndustries),
          technologies: parseMultiValueInput(localTechnologies),
          excluded_domains: parseMultiValueInput(localExcludedDomains),
          target_signals: localConfig.target_signals,
          search_queries: parseLineDelimitedInput(localSearchQueries),
          max_results: localConfig.max_results,
          min_checks_required: localConfig.min_checks_required,
          recency_window_days: localConfig.recency_window_days,
        },
      });
    } catch {
      // Scan-config write itself failed -- never attempt the territory
      // write on top of an unknown/failed state.
      toast({ variant: 'destructive', title: 'Could not save search criteria', description: 'Please try again.' });
      return;
    }

    if (selectedTerritory) {
      try {
        await updateTerritoryMutation.mutateAsync({
          id: selectedTerritory.id,
          data: { countries: localCountries.split(',').map((s) => s.trim()).filter(Boolean) },
        });
      } catch {
        // Partial save: search criteria persisted, geography did not. Say
        // exactly that -- never claim full success or full failure.
        toast({
          variant: 'destructive',
          title: 'Partially saved',
          description: 'Search criteria were saved, but geography could not be updated. Please retry.',
        });
        return;
      }
    }

    toast({ title: 'Partner search criteria saved' });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        What DRUID is looking for, by territory. This drives both discovery scans and how the AI explains why a company fits.
      </p>
      <div className="flex gap-6">
      <div className="w-56 shrink-0">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Territory</div>
        <div className="space-y-1">
          {isConfigsLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)
          ) : (
            territories?.map(t => {
              const config = configs?.find(c => c.territory_id === t.id);
              const isSelected = config ? selectedId === config.id : pendingTerritoryId === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    if (config) { setSelectedId(config.id); setPendingTerritoryId(null); }
                    else { setPendingTerritoryId(t.id); setSelectedId(null); }
                  }}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between gap-2 ${isSelected ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted text-foreground/80'}`}
                >
                  <span className="truncate">{t.name}</span>
                  {config && !config.active && (
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${isSelected ? 'border-primary-foreground/40 text-primary-foreground' : ''}`}>Inactive</Badge>
                  )}
                  {!config && (
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${isSelected ? 'border-primary-foreground/40 text-primary-foreground' : 'text-muted-foreground'}`}>Not set up</Badge>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 space-y-6">
        {pendingTerritoryId ? (
          <Card className="shadow-none border-border/60">
            <CardContent className="p-8 flex flex-col items-center text-center gap-3">
              <p className="text-sm text-muted-foreground max-w-sm">
                {territories?.find(t => t.id === pendingTerritoryId)?.name} doesn't have a Discovery configuration yet. Create one to start defining what DRUID should look for in this territory.
              </p>
              <Button
                onClick={() => createMutation.mutate({ data: { territory_id: pendingTerritoryId! } })}
                disabled={createMutation.isPending}
              >
                Create configuration
              </Button>
            </CardContent>
          </Card>
        ) : isDetailLoading || !localConfig ? (
          <div className="space-y-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            {!localConfig.active && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between gap-3">
                <p className="text-sm text-amber-800">This configuration is inactive -- Discovery scans can't run for this territory until it's activated.</p>
                <Button
                  size="sm"
                  onClick={() => selectedId && updateMutation.mutate({ id: selectedId, data: { active: true } })}
                  disabled={updateMutation.isPending}
                >
                  Activate
                </Button>
              </div>
            )}
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
                      value={localPartnerTypes}
                      onChange={e => setLocalPartnerTypes(e.target.value)}
                      placeholder="e.g. SI, VAR, Consulting"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Industries (comma separated)</Label>
                    <Input
                      value={localIndustries}
                      onChange={e => setLocalIndustries(e.target.value)}
                      placeholder="e.g. Finance, Healthcare, Retail"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Technologies / adjacencies (comma separated)</Label>
                  <Input
                    value={localTechnologies}
                    onChange={e => setLocalTechnologies(e.target.value)}
                    placeholder="e.g. Microsoft 365, Azure, SAP"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Excluded domains (comma separated)</Label>
                  <Input
                    value={localExcludedDomains}
                    onChange={e => setLocalExcludedDomains(e.target.value)}
                    placeholder="e.g. microsoft.com, amazon.com"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">Qualification &amp; search intent</CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-5">
                <div className="space-y-2">
                  <Label>Minimum qualification threshold</Label>
                  <Select
                    value={String(localConfig.min_checks_required ?? 3)}
                    onValueChange={(v) => setLocalConfig((prev: any) => ({ ...prev, min_checks_required: Number(v) }))}
                  >
                    <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3">3 of 5 checks (default)</SelectItem>
                      <SelectItem value="4">4 of 5 checks (stricter)</SelectItem>
                      <SelectItem value="5">5 of 5 checks (strictest)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Enterprise access and relevant capability are always required no matter this setting. Values below 3 aren't offered because they would have no effect: a prospect already needs at least 3 checks to qualify.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Search queries / search intent (one per line, optional)</Label>
                  <Textarea
                    value={localSearchQueries}
                    onChange={e => setLocalSearchQueries(e.target.value)}
                    placeholder={'"Genesys partner" + banking\n"launched an AI practice" + Germany'}
                    className="min-h-[100px] font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    When set, these queries completely replace automatic query planning -- Discovery searches only what's listed here. Leave empty to plan automatically from the effective criteria above: partner types, technologies/ecosystems, industries, territory geography, and target signals (below) where configured.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-none border-border/60">
              <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                <CardTitle className="text-base font-medium">Geography</CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-2">
                <Label>Territory countries (comma separated)</Label>
                <Input
                  value={localCountries}
                  onChange={e => setLocalCountries(e.target.value)}
                  placeholder="e.g. Germany, Austria, Switzerland"
                />
                <p className="text-xs text-muted-foreground">
                  This is the {selectedTerritory?.name ?? 'territory'}&apos;s geography as a whole, not just this scan configuration -- it also applies anywhere else the territory's countries are used.
                </p>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={isSaving}>
                <Save className="h-4 w-4 mr-2" />
                Save partner search criteria
              </Button>
            </div>
          </>
        )}
      </div>
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

function ConnectionStatusBadge({ status, hasCredential, enabled }: { status: string; hasCredential: boolean; enabled: boolean }) {
  const tone = getConnectionTone(status, hasCredential, enabled);
  if (tone === 'disabled') return <Badge variant="outline" className="text-muted-foreground font-normal shrink-0">Disabled</Badge>;
  if (tone === 'connected') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal shrink-0"><span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Connected</span></Badge>;
  if (tone === 'configured') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal shrink-0"><span className="flex items-center gap-1"><Eye className="h-3 w-3" /> Configured</span></Badge>;
  if (tone === 'error') return <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal shrink-0"><span className="flex items-center gap-1"><XCircle className="h-3 w-3" /> Error</span></Badge>;
  // not_configured: a missing credential is a normal, expected
  // configuration state on this page (not evidence of an outage) --
  // neutral/grey, never red.
  return <Badge variant="outline" className="text-muted-foreground font-normal shrink-0">Not configured</Badge>;
}

// Phase 11.5B: only these two provider types get DB-stored-secret UI in this
// slice (Tavily/web_search, DeepSeek/ai) -- HubSpot stays untouched for
// Phase 12, and Web Reader is currently unwired (Phase 11.5C reuses the
// Tavily credential rather than introducing a separate one). Both still get
// the env-var-only display/test behavior they already had.
const SECRET_MANAGEABLE_PROVIDER_TYPES = new Set(['web_search', 'ai']);

function ReplaceConnectionSecretDialog({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');

  const setSecretMutation = useSetConnectionSecret({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListConnectionsQueryKey() });
        toast({ title: 'Credential saved', description: `${connection.provider_name}'s stored credential was updated.` });
        onClose();
      },
      onError: (err: any) => {
        toast({ title: 'Could not save credential', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const clearSecretMutation = useSetConnectionSecret({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListConnectionsQueryKey() });
        toast({ title: 'Stored credential cleared', description: `${connection.provider_name} now falls back to its environment variable, if set.` });
        onClose();
      },
      onError: (err: any) => {
        toast({ title: 'Could not clear credential', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const busy = setSecretMutation.isPending || clearSecretMutation.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Replace {connection.provider_name} credential</DialogTitle>
          <DialogDescription>
            Stored encrypted at rest. Only the last 4 characters are ever shown again after saving.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="connection-secret-value">New credential value</Label>
          <Input
            id="connection-secret-value"
            type="password"
            autoComplete="off"
            placeholder={connection.has_db_secret ? `Replaces the stored credential ending in ${connection.secret_last4}` : 'Paste the credential value'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <DialogFooter className="sm:justify-between">
          {connection.has_db_secret ? (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy}
              onClick={() => clearSecretMutation.mutate({ id: connection.id, data: { secret: null } })}
            >
              Clear stored credential (revert to env var)
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button
              disabled={busy || !value.trim()}
              onClick={() => setSecretMutation.mutate({ id: connection.id, data: { secret: value } })}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
  const secretManageable = SECRET_MANAGEABLE_PROVIDER_TYPES.has(connection.provider_type);
  const [replaceDialogOpen, setReplaceDialogOpen] = useState(false);

  const testMutation = useTestConnection({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListConnectionsQueryKey() });
        const failed = isErrorTone(getConnectionTone(result.status, result.has_credential, result.enabled));
        toast({
          title: failed ? 'Connection failed' : 'Test complete',
          description: result.last_error ?? undefined,
          variant: failed ? 'destructive' : 'default',
        });
      },
      onError: (err: any) => {
        toast({ title: 'Test failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const enabledMutation = useUpdateConnection({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListConnectionsQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: 'Could not update connection', description: err?.message ?? 'Unknown error', variant: 'destructive' });
      },
    },
  });

  const credentialLine = secretManageable
    ? connection.has_db_secret
      ? `Stored credential: •••• ${connection.secret_last4}`
      : connection.credential_env_var
        ? <>Env fallback: <code className="text-[11px]">{connection.credential_env_var}</code>{connection.has_credential ? ' (set)' : ' (not set)'}</>
        : 'No credential configured'
    : <>Credential: <code className="text-[11px]">{connection.credential_env_var}</code>{connection.has_credential ? ' (set)' : ' (not set)'}</>;

  return (
    <Card className="shadow-none border-border/60">
      <CardHeader className="flex flex-row items-start justify-between py-4 px-5 border-b border-border/50 bg-muted/20 space-y-0">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base font-medium">{connection.provider_name}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">{credentialLine}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {secretManageable && (
            <div className="flex items-center gap-1.5">
              <Switch
                checked={connection.enabled}
                disabled={enabledMutation.isPending}
                onCheckedChange={(checked) => enabledMutation.mutate({ id: connection.id, data: { enabled: checked } })}
                aria-label={`${connection.enabled ? 'Disable' : 'Enable'} ${connection.provider_name}`}
              />
              <span className="text-xs text-muted-foreground">{connection.enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
          )}
          <ConnectionStatusBadge status={connection.status} hasCredential={connection.has_credential} enabled={connection.enabled} />
        </div>
      </CardHeader>
      <CardContent className="p-5 flex items-center justify-between gap-4">
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            <span className="font-medium text-foreground">Last tested: </span>
            {connection.last_tested_at ? format(new Date(connection.last_tested_at), 'MMM d, HH:mm') : 'Never'}
          </p>
          {connection.last_error && (
            <p className={isErrorTone(getConnectionTone(connection.status, connection.has_credential, connection.enabled)) ? 'text-rose-600' : 'text-muted-foreground'}>{connection.last_error}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {secretManageable && (
            <Button variant="outline" size="sm" onClick={() => setReplaceDialogOpen(true)}>
              Replace
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate({ id: connection.id })}
          >
            {testMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
            Test connection
          </Button>
        </div>
      </CardContent>
      {replaceDialogOpen && <ReplaceConnectionSecretDialog connection={connection} onClose={() => setReplaceDialogOpen(false)} />}
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
              <p className="text-xs text-muted-foreground">
                Sets the current/actual value only. Targets are configured separately from the Overview KPI card ("Set target") -- there is one canonical target mechanism, not two.
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs">Current value</Label>
                <Input value={manualCurrent} onChange={(e) => setManualCurrent(e.target.value)} placeholder="0" />
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

const RADAR_SIGNAL_TYPE_OPTIONS = [
  { id: 'acquisition', label: 'Acquisitions / M&A' },
  { id: 'partnership', label: 'Partnerships / alliances' },
  { id: 'reseller_distributor', label: 'Reseller / distributor / SI' },
  { id: 'regional_expansion', label: 'Regional expansion' },
  { id: 'leadership_hire', label: 'Channel / alliance hires' },
  { id: 'funding', label: 'Funding' },
  { id: 'customer_win', label: 'Customer wins' },
  { id: 'product_gtm', label: 'Product / GTM moves' },
  { id: 'marketplace_listing', label: 'Marketplace / ecosystem listings' },
  { id: 'event', label: 'Webinars / conferences / events' },
  { id: 'other', label: 'Other ecosystem moves' },
];

// Mirrors WhatToLookForTab's create/activate/edit pattern exactly -- one
// config per territory, a "Create configuration" CTA for territories that
// don't have one yet, an inactive-state banner with Activate otherwise.
function ChannelRadarTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: configs, isLoading: isConfigsLoading } = useListChannelRadarConfigs();
  const { data: territories } = useListTerritories();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingTerritoryId, setPendingTerritoryId] = useState<string | null>(null);
  const [localConfig, setLocalConfig] = useState<any>(null);
  // Raw text kept separate from localConfig -- see multi-value-input.ts.
  const [localMonitoredEntities, setLocalMonitoredEntities] = useState<string>('');

  const { data: detail, isLoading: isDetailLoading } = useGetChannelRadarConfig(
    selectedId || '',
    { query: { enabled: !!selectedId, queryKey: getGetChannelRadarConfigQueryKey(selectedId || '') } }
  );

  const createMutation = useCreateChannelRadarConfig({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListChannelRadarConfigsQueryKey() });
        setPendingTerritoryId(null);
        setSelectedId(data.id);
        toast({ title: 'Channel Radar configuration created', description: 'Add entities to monitor and signal types below.' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not create configuration', description: err?.message ?? 'Please try again.' });
      },
    },
  });

  const updateMutation = useUpdateChannelRadarConfig({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListChannelRadarConfigsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetChannelRadarConfigQueryKey(data.id) });
        setLocalConfig(data);
        toast({ title: 'Channel Radar configuration saved' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not save configuration', description: err?.message ?? 'Please try again.' });
      },
    },
  });

  useEffect(() => {
    if (configs && configs.length > 0 && !selectedId) {
      setSelectedId(configs[0].id);
    }
  }, [configs, selectedId]);

  useEffect(() => {
    if (detail) {
      setLocalConfig(JSON.parse(JSON.stringify(detail)));
      setLocalMonitoredEntities(formatMultiValueInput(detail.monitored_entities));
    }
  }, [detail]);

  const handleSave = () => {
    if (!selectedId || !localConfig) return;
    updateMutation.mutate({
      id: selectedId,
      data: {
        monitored_entities: parseMultiValueInput(localMonitoredEntities),
        enabled_signal_types: localConfig.enabled_signal_types,
        lookback_days: localConfig.lookback_days,
      },
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Regional competitive and ecosystem intelligence, by territory -- what to monitor and which signal types matter.
      </p>
      <div className="flex gap-6">
        <div className="w-56 shrink-0">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Territory</div>
          <div className="space-y-1">
            {isConfigsLoading ? (
              Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)
            ) : (
              territories?.map((t) => {
                const config = configs?.find((c) => c.territory_id === t.id);
                const isSelected = config ? selectedId === config.id : pendingTerritoryId === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      if (config) { setSelectedId(config.id); setPendingTerritoryId(null); }
                      else { setPendingTerritoryId(t.id); setSelectedId(null); }
                    }}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between gap-2 ${isSelected ? 'bg-primary text-primary-foreground font-medium' : 'hover:bg-muted text-foreground/80'}`}
                  >
                    <span className="truncate">{t.name}</span>
                    {config && !config.active && (
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${isSelected ? 'border-primary-foreground/40 text-primary-foreground' : ''}`}>Inactive</Badge>
                    )}
                    {!config && (
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${isSelected ? 'border-primary-foreground/40 text-primary-foreground' : 'text-muted-foreground'}`}>Not set up</Badge>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex-1 min-w-0 space-y-6">
          {pendingTerritoryId ? (
            <Card className="shadow-none border-border/60">
              <CardContent className="p-8 flex flex-col items-center text-center gap-3">
                <p className="text-sm text-muted-foreground max-w-sm">
                  {territories?.find((t) => t.id === pendingTerritoryId)?.name} doesn't have a Channel Radar configuration yet. Create one to start monitoring competitive and ecosystem signals.
                </p>
                <Button onClick={() => createMutation.mutate({ data: { territory_id: pendingTerritoryId! } })} disabled={createMutation.isPending}>
                  Create configuration
                </Button>
              </CardContent>
            </Card>
          ) : isDetailLoading || !localConfig ? (
            <div className="space-y-4">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <>
              {!localConfig.active && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between gap-3">
                  <p className="text-sm text-amber-800">This configuration is inactive -- Run Radar can't be used for this territory until it's activated.</p>
                  <Button
                    size="sm"
                    onClick={() => selectedId && updateMutation.mutate({ id: selectedId, data: { active: true } })}
                    disabled={updateMutation.isPending}
                  >
                    Activate
                  </Button>
                </div>
              )}

              <Card className="shadow-none border-border/60">
                <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                  <CardTitle className="text-base font-medium">Entities to monitor</CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-2">
                  <Label>Company names (comma separated)</Label>
                  <Input
                    value={localMonitoredEntities}
                    onChange={(e) => setLocalMonitoredEntities(e.target.value)}
                    placeholder="e.g. Microsoft, UiPath, Kore.ai, Cognigy, ServiceNow"
                  />
                </CardContent>
              </Card>

              <Card className="shadow-none border-border/60">
                <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                  <CardTitle className="text-base font-medium">Signal types</CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-5">
                  <div className="grid grid-cols-2 gap-2">
                    {RADAR_SIGNAL_TYPE_OPTIONS.map((opt) => {
                      const selected: string[] = localConfig.enabled_signal_types || [];
                      const checked = selected.includes(opt.id);
                      return (
                        <div key={opt.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={`radar-sig-${opt.id}`}
                            checked={checked}
                            onCheckedChange={(value) => {
                              setLocalConfig((prev: any) => ({
                                ...prev,
                                enabled_signal_types: value
                                  ? [...(prev.enabled_signal_types || []), opt.id]
                                  : (prev.enabled_signal_types || []).filter((s: string) => s !== opt.id),
                              }));
                            }}
                          />
                          <Label htmlFor={`radar-sig-${opt.id}`} className="font-normal cursor-pointer">{opt.label}</Label>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              <Card className="shadow-none border-border/60">
                <CardHeader className="py-4 px-5 border-b border-border/50 bg-muted/20">
                  <CardTitle className="text-base font-medium">Lookback</CardTitle>
                </CardHeader>
                <CardContent className="p-5">
                  <Label>Lookback period (days)</Label>
                  <Input
                    type="number"
                    min={1}
                    className="w-32 mt-2"
                    value={localConfig.lookback_days ?? 30}
                    onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, lookback_days: Number(e.target.value) || 30 }))}
                  />
                  <p className="text-xs text-muted-foreground mt-2">
                    Enforced as a real search-provider date filter -- Run Radar only searches from this many days ago onward.
                  </p>
                </CardContent>
              </Card>

              <Button onClick={handleSave} disabled={updateMutation.isPending}>Save changes</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Phase 11.5A: admin-only visibility/restore for PAM-created "don't
// suggest this company again" exclusions (see DELETE /prospects/:id's
// exclude_company option). Deliberately plain business language -- no
// domain-matching internals, no bulk actions, no raw IDs as the primary
// UX. Restoring makes the company eligible for Discovery again.
function ExcludedResearchResultsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: exclusions, isLoading } = useListDiscoveryExclusions();

  const restoreMutation = useRestoreDiscoveryExclusion({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDiscoveryExclusionsQueryKey() });
        toast({ title: 'Company restored', description: 'It can be suggested by Discovery again.' });
      },
      onError: (err: any) => {
        toast({
          variant: 'destructive',
          title: 'Could not restore',
          description: err?.data?.error ?? err?.message ?? 'The exclusion could not be restored.',
        });
      },
    },
  });

  const REASON_LABELS: Record<string, string> = {
    not_relevant: 'Not a relevant partner',
    wrong_match: 'Wrong company or bad match',
    bad_source: 'Bad source or garbage result',
    other: 'Other',
  };

  return (
    <div>
      <h3 className="text-sm font-medium mb-1">Excluded research results</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Companies a PAM marked "don't suggest again." Discovery skips them until restored here.
      </p>
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !exclusions || exclusions.length === 0 ? (
        <p className="text-sm text-muted-foreground border border-dashed border-border/60 rounded-md p-4">
          No companies are currently excluded from research.
        </p>
      ) : (
        <div className="border border-border/60 rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company / domain</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Excluded by</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exclusions.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.company_name ?? e.domain}</TableCell>
                  <TableCell className="text-muted-foreground">{REASON_LABELS[e.reason] ?? e.reason}</TableCell>
                  <TableCell className="text-muted-foreground">{e.created_by_name ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(e.created_at).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => restoreMutation.mutate({ id: e.id })}
                      disabled={restoreMutation.isPending}
                    >
                      Restore
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
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
          AI and Web Search credentials can be entered here (encrypted at rest, masked after saving) or left as
          environment variables. HubSpot and Web Reader credentials are managed as environment variables only.
        </p>
        {connectionsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-3">
            {sortConnectionsByDisplayOrder(connections ?? []).map((c) => <ConnectionCard key={c.id} connection={c} />)}
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

      <ExcludedResearchResultsSection />

      {editingMapping && (
        <MetricMappingDrawer mapping={editingMapping} onClose={() => setEditingMapping(null)} />
      )}
    </div>
  );
}

// Phase 11.5C.1: DRUID Context foundation -- admin-curated facts about DRUID
// itself (product, positioning, ideal partner profile), kept deliberately
// plain (no "prompt playground", no chunk/embedding UI). Not yet wired into
// Discovery or Channel Radar -- only verified, active facts are ever
// eligible to ground research, once that wiring lands in a later slice.
const DRUID_FACT_CATEGORY_LABELS: Record<string, string> = {
  product: 'Product',
  positioning: 'Positioning',
  ideal_partner_profile: 'Ideal partner profile',
  technology_ecosystem: 'Technology ecosystem',
  proof_point: 'Proof point',
  other: 'Other',
};

function DruidFactStatusBadge({ fact }: { fact: DruidFact }) {
  if (!fact.active) {
    return <Badge variant="outline" className="text-muted-foreground font-normal">Inactive</Badge>;
  }
  if (fact.verification_status === 'verified') {
    return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal">Verified</Badge>;
  }
  return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal">Unverified</Badge>;
}

/** Add/edit dialog. `fact === null` is create mode. */
function DruidFactFormDialog({ fact, onClose }: { fact: DruidFact | null; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEdit = !!fact;

  const [category, setCategory] = useState<string>(fact?.category ?? 'product');
  const [factText, setFactText] = useState(fact?.fact_text ?? '');
  const [sourceUrl, setSourceUrl] = useState(fact?.source_url ?? '');
  const [sourceNote, setSourceNote] = useState(fact?.source_note ?? '');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListDruidFactsQueryKey() });

  const createMutation = useCreateDruidFact({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Fact added', description: 'New facts start unverified until reviewed.' });
        onClose();
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not add fact', description: err?.data?.error ?? err?.message ?? 'Unknown error' });
      },
    },
  });

  const updateMutation = useUpdateDruidFact({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Fact updated' });
        onClose();
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not update fact', description: err?.data?.error ?? err?.message ?? 'Unknown error' });
      },
    },
  });

  const busy = createMutation.isPending || updateMutation.isPending;

  const submit = () => {
    const data = {
      category: category as DruidFact['category'],
      fact_text: factText.trim(),
      source_url: sourceUrl.trim() || null,
      source_note: sourceNote.trim() || null,
    };
    if (isEdit) updateMutation.mutate({ id: fact!.id, data });
    else createMutation.mutate({ data });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit DRUID fact' : 'Add DRUID fact'}</DialogTitle>
          <DialogDescription>
            {isEdit && fact!.verification_status === 'verified'
              ? 'This fact is verified -- saving changes resets it to unverified, and it will need to be verified again.'
              : "A short, standalone fact about DRUID's product, positioning, or the kind of partner it's looking for."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DRUID_FACT_CATEGORY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="druid-fact-text">Fact</Label>
            <Textarea
              id="druid-fact-text"
              rows={3}
              value={factText}
              onChange={(e) => setFactText(e.target.value)}
              placeholder="e.g. DRUID is an enterprise conversational/agentic AI platform vendor."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="druid-fact-source-url">Source URL{fact?.source_type === 'ingested' ? '' : ' (optional)'}</Label>
            {fact?.source_type === 'ingested' ? (
              <div id="druid-fact-source-url" className="text-sm rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-muted-foreground break-all">
                {sourceUrl || '—'}
                <span className="block text-xs mt-1">From ingested DRUID source material -- not editable here.</span>
              </div>
            ) : (
              <Input
                id="druid-fact-source-url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://druidai.com/..."
              />
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="druid-fact-source-note">Source note (optional)</Label>
            <Input
              id="druid-fact-source-note"
              value={sourceNote}
              onChange={(e) => setSourceNote(e.target.value)}
              placeholder="e.g. internal positioning statement, agreed with Head of Channels"
            />
            <p className="text-xs text-muted-foreground">
              A source URL or a source note is required before this fact can be verified.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !factText.trim()} onClick={submit}>{isEdit ? 'Save' : 'Add fact'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DruidFactsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: facts, isLoading } = useListDruidFacts();
  const { data: users } = useListUsers();
  // null = create mode, a DruidFact = edit mode, undefined = dialog closed.
  const [editingFact, setEditingFact] = useState<DruidFact | null | undefined>(undefined);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListDruidFactsQueryKey() });

  const verifyMutation = useVerifyDruidFact({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Fact verified' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not verify', description: err?.data?.error ?? err?.message ?? 'The fact could not be verified.' });
      },
    },
  });

  const deactivateMutation = useDeactivateDruidFact({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Fact deactivated' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not deactivate', description: err?.data?.error ?? err?.message ?? 'Unknown error' });
      },
    },
  });

  const reactivateMutation = useReactivateDruidFact({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Fact reactivated', description: 'It is unverified again until re-reviewed.' });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not reactivate', description: err?.data?.error ?? err?.message ?? 'Unknown error' });
      },
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-medium">DRUID facts</h3>
        <Button size="sm" onClick={() => setEditingFact(null)}>
          <Plus className="h-4 w-4 mr-1" /> Add fact
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        What DRUID is, its positioning, and the kind of partner it's looking for. Only verified, active facts are ever eligible to ground research -- not yet used by Discovery or Channel Radar.
      </p>
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !facts || facts.length === 0 ? (
        <p className="text-sm text-muted-foreground border border-dashed border-border/60 rounded-md p-4">
          No DRUID facts yet.
        </p>
      ) : (
        <div className="border border-border/60 rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Fact</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated by</TableHead>
                <TableHead className="text-right">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {facts.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="text-muted-foreground whitespace-nowrap">{DRUID_FACT_CATEGORY_LABELS[f.category] ?? f.category}</TableCell>
                  <TableCell className="font-medium max-w-[320px]">{f.fact_text}</TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[220px] truncate">
                    {f.source_url ? (
                      <a href={f.source_url} target="_blank" rel="noreferrer" className="underline">{f.source_url}</a>
                    ) : (
                      f.source_note || '—'
                    )}
                  </TableCell>
                  <TableCell><DruidFactStatusBadge fact={f} /></TableCell>
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    {users?.find((u) => u.id === f.updated_by_user_id)?.name || '—'}
                    <span className="block text-xs">{format(new Date(f.updated_at), 'MMM d, yyyy')}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditingFact(f)}>Edit</Button>
                      {f.active && f.verification_status === 'unverified' && (
                        <Button variant="outline" size="sm" disabled={verifyMutation.isPending} onClick={() => verifyMutation.mutate({ id: f.id })}>
                          Verify
                        </Button>
                      )}
                      {f.active ? (
                        <Button variant="outline" size="sm" disabled={deactivateMutation.isPending} onClick={() => deactivateMutation.mutate({ id: f.id })}>
                          Deactivate
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate({ id: f.id })}>
                          Reactivate
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editingFact !== undefined && <DruidFactFormDialog fact={editingFact} onClose={() => setEditingFact(undefined)} />}
    </div>
  );
}

// Phase 11.5C.2: druidai.com source material -- extracted evidence, never
// itself a trusted fact. Deliberately plain: no crawler/provider settings,
// no chunk/vector/embedding/RAG language. "Mark reviewed"/"Ignore" are only
// meaningful from pending_review (the list only ever shows pending_review
// and reviewed sources -- ignored ones are excluded server-side); "Create
// fact" stays available on a reviewed source too, since one source can
// support multiple facts.
function DruidContextSourceStatusBadge({ status }: { status: string }) {
  if (status === 'reviewed') {
    return <Badge variant="outline" className="text-sky-700 bg-sky-50 border-sky-200 font-normal">Reviewed</Badge>;
  }
  return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal">Pending review</Badge>;
}

function CreateFactFromSourceDialog({ source, onClose }: { source: DruidContextSource; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<string>('product');
  const [factText, setFactText] = useState(source.extracted_text.slice(0, 500));
  const [sourceNote, setSourceNote] = useState('');

  const createMutation = useCreateFactFromDruidContextSource({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDruidContextSourcesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListDruidFactsQueryKey() });
        toast({ title: 'Fact created', description: 'It is unverified -- use Verify in DRUID facts to trust it.' });
        onClose();
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not create fact', description: err?.data?.error ?? err?.message ?? 'Unknown error' });
      },
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !createMutation.isPending && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Create DRUID fact from source</DialogTitle>
          <DialogDescription>
            Rewrite the extracted material into a concise, standalone fact. The new fact starts <strong>unverified</strong> -- it still needs the existing Verify action before it counts as trusted DRUID context.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DRUID_FACT_CATEGORY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="source-fact-text">Fact</Label>
            <Textarea id="source-fact-text" rows={4} value={factText} onChange={(e) => setFactText(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="source-fact-note">Source note (optional)</Label>
            <Input id="source-fact-note" value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} placeholder="e.g. summarized from the pricing page" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={createMutation.isPending} onClick={onClose}>Cancel</Button>
          <Button
            disabled={createMutation.isPending || !factText.trim()}
            onClick={() => createMutation.mutate({ id: source.id, data: { category: category as any, fact_text: factText.trim(), source_note: sourceNote.trim() || null } })}
          >
            Create fact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DruidContextSourcesSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: sources, isLoading } = useListDruidContextSources();
  const [factSourceTarget, setFactSourceTarget] = useState<DruidContextSource | null>(null);
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListDruidContextSourcesQueryKey() });

  const refreshMutation = useRefreshDruidContextSources({
    mutation: {
      onSuccess: (result) => {
        invalidate();
        toast({
          title: 'Refreshed from druidai.com',
          description: `${result.pages_crawled} pages crawled -- ${result.new_sources} new, ${result.updated_sources} unchanged.`,
        });
      },
      onError: (err: any) => {
        toast({ variant: 'destructive', title: 'Could not refresh', description: err?.data?.error ?? err?.message ?? 'Unknown error' });
      },
    },
  });

  const reviewMutation = useReviewDruidContextSource({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: 'Marked reviewed' }); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not mark reviewed', description: err?.data?.error ?? err?.message ?? 'Unknown error' }),
    },
  });

  const ignoreMutation = useIgnoreDruidContextSource({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: 'Source ignored' }); },
      onError: (err: any) => toast({ variant: 'destructive', title: 'Could not ignore', description: err?.data?.error ?? err?.message ?? 'Unknown error' }),
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-medium">Source material</h3>
        <Button size="sm" variant="outline" disabled={refreshMutation.isPending} onClick={() => refreshMutation.mutate()}>
          {refreshMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
          Refresh from druidai.com
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Extracted druidai.com pages, for review. Creating a fact from a source never verifies it -- every created fact is unverified until explicitly verified above.
      </p>
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !sources || sources.length === 0 ? (
        <p className="text-sm text-muted-foreground border border-dashed border-border/60 rounded-md p-4">
          No source material yet. Click "Refresh from druidai.com" to fetch some.
        </p>
      ) : (
        <div className="border border-border/60 rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((s) => {
                const expanded = expandedSourceId === s.id;
                return (
                  <React.Fragment key={s.id}>
                    <TableRow>
                      <TableCell className="max-w-[420px]">
                        <a href={s.source_url} target="_blank" rel="noreferrer" className="underline font-medium block truncate">{s.source_url}</a>
                        <button type="button" className="text-xs text-muted-foreground underline mt-0.5" onClick={() => setExpandedSourceId(expanded ? null : s.id)}>
                          {expanded ? 'Hide extracted text' : 'View extracted text'}
                        </button>
                      </TableCell>
                      <TableCell><DruidContextSourceStatusBadge status={s.review_status} /></TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {s.review_status === 'pending_review' && (
                            <>
                              <Button variant="outline" size="sm" disabled={reviewMutation.isPending} onClick={() => reviewMutation.mutate({ id: s.id })}>
                                Mark reviewed
                              </Button>
                              <Button variant="outline" size="sm" disabled={ignoreMutation.isPending} onClick={() => ignoreMutation.mutate({ id: s.id })}>
                                Ignore
                              </Button>
                            </>
                          )}
                          <Button size="sm" onClick={() => setFactSourceTarget(s)}>Create fact</Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow>
                        <TableCell colSpan={3} className="bg-muted/30">
                          <p className="text-xs whitespace-pre-wrap text-muted-foreground max-h-64 overflow-y-auto">{s.extracted_text}</p>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {factSourceTarget && <CreateFactFromSourceDialog source={factSourceTarget} onClose={() => setFactSourceTarget(null)} />}
    </div>
  );
}

function DruidContextTab() {
  return (
    <div className="space-y-8">
      <DruidFactsSection />
      <DruidContextSourcesSection />
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
          <TabsTrigger value="what-to-look-for">Partner search criteria</TabsTrigger>
          <TabsTrigger value="channel-radar">Channel Radar</TabsTrigger>
          <TabsTrigger value="connections">Connections & data</TabsTrigger>
          <TabsTrigger value="druid-context">DRUID context</TabsTrigger>
        </TabsList>
        <TabsContent value="team" className="mt-6">
          <TeamTab />
        </TabsContent>
        <TabsContent value="what-to-look-for" className="mt-6">
          <WhatToLookForTab />
        </TabsContent>
        <TabsContent value="channel-radar" className="mt-6">
          <ChannelRadarTab />
        </TabsContent>
        <TabsContent value="connections" className="mt-6">
          <ConnectionsDataTab />
        </TabsContent>
        <TabsContent value="druid-context" className="mt-6">
          <DruidContextTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
