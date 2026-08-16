import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  useGetHeadOfChannelsKpis,
  getGetHeadOfChannelsKpisQueryKey,
  useListTerritories,
  useGetKpiDetails,
  getGetKpiDetailsQueryKey,
  useListMetricTargets,
  getListMetricTargetsQueryKey,
  useUpsertMetricTarget,
  useDeleteMetricTarget,
  useGetAiChannelBrief,
  getGetAiChannelBriefQueryKey,
  useRegenerateAiChannelBrief,
  useListUsers,
  getListUsersQueryKey,
  exportQuarterlyPptx,
  exportManagementPptx,
  ApiError,
  type AiChannelBrief,
  type AiBriefEvidenceItem,
  type User,
} from '@workspace/api-client-react';
import { useSearch, useLocation } from 'wouter';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WeeklyTeamView } from '@/components/weekly-team-view';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionCard, SectionCardHeader, SectionCardContent } from '@/components/section-card';
import { ArrowDown, ArrowUp, Minus, X, Download, Loader2, Pencil, Sparkles, RefreshCw, Sun, Moon, ChevronDown } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { type Currency, formatMetricValue, formatTrendLabel, formatStatusLabel } from '@/lib/kpi-format';
import { findExistingTarget } from '@/lib/metric-target-selection';
import { getDefaultPeriodKey, splitPeriodKey, getCurrentYear } from '@/lib/period';
import { PeriodSelector } from '@/components/period-selector';
import { PamActionQueue } from '@/components/pam-action-queue';
import { CommercialPerformanceHead, CommercialPerformancePam } from '@/components/commercial-performance';
import type { KpiPeriod } from '@workspace/api-client-react';

function StatusBadge({ status }: { status: string | null }) {
  if (status === 'green' || status === 'on_track') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal">On track</Badge>;
  if (status === 'amber') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal">Needs attention</Badge>;
  if (status === 'red') return <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal">At risk</Badge>;
  return <Badge variant="outline" className="text-muted-foreground font-normal">--</Badge>;
}

function TrendIcon({ trend }: { trend: string | null }) {
  if (trend === 'up') return <ArrowUp className="h-4 w-4 text-emerald-600 inline" />;
  if (trend === 'down') return <ArrowDown className="h-4 w-4 text-rose-600 inline" />;
  if (trend === 'flat') return <Minus className="h-4 w-4 text-muted-foreground inline" />;
  return null;
}

function DataStatusBadge({ status }: { status: string }) {
  if (status === 'CONNECTED') return <Badge variant="outline" className="text-emerald-700 bg-emerald-50 border-emerald-200 font-normal text-xs">Connected</Badge>;
  if (status === 'MANUAL') return <Badge variant="outline" className="text-sky-700 bg-sky-50 border-sky-200 font-normal text-xs">Manual</Badge>;
  if (status === 'DEMO') return <Badge variant="outline" className="text-amber-700 bg-amber-50 border-amber-200 font-normal text-xs">Demo data</Badge>;
  return <Badge variant="outline" className="text-muted-foreground font-normal text-xs">Not connected</Badge>;
}

function CoreBadge() {
  return (
    <Badge variant="outline" className="text-primary/80 border-primary/30 bg-primary/5 font-medium text-[10px] tracking-wide px-1.5 py-0">
      CORE
    </Badge>
  );
}

// Every highlight/risk/opportunity/action is rendered with the exact
// metric_key(s) the AI cited as evidence for it -- this is what keeps the
// panel honest as an interpretation of the connected data rather than an
// unattributed claim. metricLabelByKey is best-effort (falls back to the
// raw key), never blocking on it.
function AiBriefEvidenceList({ title, items, metricLabelByKey }: { title: string; items: AiBriefEvidenceItem[]; metricLabelByKey: Map<string, string> }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">{title}</h4>
      <ul className="space-y-2.5">
        {items.map((item, i) => (
          <li key={i} className="text-sm leading-relaxed">
            <p className="text-foreground">{item.text}</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {item.supporting_metrics.map((key) => (
                <Badge key={key} variant="outline" className="text-[10px] font-normal text-muted-foreground px-1.5 py-0">
                  {metricLabelByKey.get(key) ?? key}
                </Badge>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AiChannelBriefPanel({
  brief,
  isLoading,
  onRegenerate,
  isRegenerating,
  metricLabelByKey,
}: {
  brief: AiChannelBrief | undefined;
  isLoading: boolean;
  onRegenerate: () => void;
  isRegenerating: boolean;
  metricLabelByKey: Map<string, string>;
}) {
  if (isLoading) {
    return (
      <SectionCard>
        <SectionCardContent>
          <Skeleton className="h-20 w-full" />
        </SectionCardContent>
      </SectionCard>
    );
  }
  if (!brief) return null;

  const notConfigured = brief.provider_status === 'not_configured';

  return (
    <SectionCard>
      <SectionCardHeader
        title={
          <span className="flex items-center gap-2">
            {/* Phase 11.6B: decorative icon accent, not text -- uses the raw
                --brand DRUID green rather than the accessible-contrast
                --primary shade, per the 11.6A brand/primary separation
                (non-text accents may use the true brand color). */}
            <Sparkles className="h-4 w-4 text-brand" />
            AI Channel Brief
            <Badge variant="outline" className="text-primary/80 border-primary/30 bg-primary/5 font-medium text-[10px] tracking-wide px-1.5 py-0">
              AI-GENERATED
            </Badge>
          </span>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={onRegenerate}
            disabled={!brief.can_regenerate || isRegenerating}
            data-testid="button-regenerate-ai-brief"
          >
            {isRegenerating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            {brief.state === 'never_generated' ? 'Generate brief' : 'Regenerate'}
          </Button>
        }
      />
      <SectionCardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          AI-generated interpretation, based only on the connected/manual metrics referenced below -- not a substitute for reviewing the tables yourself.
        </p>

        {notConfigured && (
          <div className="rounded-md border border-border/60 bg-muted/10 p-3 text-sm text-muted-foreground">
            AI provider is not connected. An admin can configure it in Admin &gt; Connections &amp; data.
          </div>
        )}

        {brief.state === 'insufficient_data' && (
          <p className="text-sm text-muted-foreground">
            Not enough connected data yet for this scope to generate a brief.
          </p>
        )}

        {brief.state === 'never_generated' && !notConfigured && (
          <p className="text-sm text-muted-foreground">
            No brief has been generated yet for this period, territory, and currency. Generate one from the current connected data.
          </p>
        )}

        {brief.content && (
          <div className="space-y-4">
            <p className="text-body">{brief.content.executive_summary}</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <AiBriefEvidenceList title="Risks" items={brief.content.risks} metricLabelByKey={metricLabelByKey} />
              <AiBriefEvidenceList title="Recommended actions" items={brief.content.recommended_actions} metricLabelByKey={metricLabelByKey} />
            </div>

            <AiBriefEvidenceList title="Key highlights" items={brief.content.key_highlights} metricLabelByKey={metricLabelByKey} />
            <AiBriefEvidenceList title="Opportunities" items={brief.content.opportunities} metricLabelByKey={metricLabelByKey} />

            {(brief.data_as_of || brief.generated_at) && (
              <div className="text-xs text-muted-foreground border-t border-border/50 pt-3 space-y-0.5">
                {brief.data_as_of && <p>Data as of: {new Date(brief.data_as_of).toLocaleString()}</p>}
                {brief.generated_at && <p>Generated: {new Date(brief.generated_at).toLocaleString()}</p>}
              </div>
            )}
          </div>
        )}
      </SectionCardContent>
    </SectionCard>
  );
}

// -- PAM Local Time --------------------------------------------------------
// Free, no-key, CORS-open public time API (verified: access-control-allow-
// origin: * on this exact path). Attribution requested by the provider is
// in the footer link in PamLocalTimeSection below.
const TIME_NOW_REFRESH_MS = 5 * 60 * 1000; // re-sync with the authoritative source every 5 min
const LOCAL_TICK_MS = 60 * 1000; // advance the displayed clock locally once a minute between refreshes

interface PamClockState {
  status: 'loading' | 'ok' | 'error';
  date: Date | null;
  abbreviation: string | null;
}

// A Date is an absolute instant, timezone-agnostic in itself -- Intl is
// used here (not manual utc_offset arithmetic) to read the correct local
// wall-clock hour/minute for a specific IANA zone, since it already
// handles DST correctly for that instant.
function getZonedHourMinute(date: Date, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

// Fetches the authoritative time once per timezone, then advances the
// display locally every minute between refreshes -- no network call on
// every tick. A refresh failure never erases an already-working clock; it
// only flips to "error" if no authoritative baseline was ever obtained,
// and other PAMs' clocks (separate hook instances) are unaffected either way.
function usePamClock(timezone: string | null): PamClockState {
  const [state, setState] = useState<PamClockState>({ status: 'loading', date: null, abbreviation: null });
  const baselineRef = useRef<{ unixtimeMs: number; fetchedAtMs: number; abbreviation: string | null } | null>(null);

  useEffect(() => {
    if (!timezone) return;
    let cancelled = false;
    baselineRef.current = null;
    setState({ status: 'loading', date: null, abbreviation: null });

    const fetchAuthoritative = async () => {
      try {
        const res = await fetch(`https://time.now/developer/api/timezone/${timezone}`);
        if (!res.ok) throw new Error(`time.now responded ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        baselineRef.current = { unixtimeMs: body.unixtime * 1000, fetchedAtMs: Date.now(), abbreviation: body.abbreviation ?? null };
        setState({ status: 'ok', date: new Date(body.unixtime * 1000), abbreviation: body.abbreviation ?? null });
      } catch {
        if (!cancelled && !baselineRef.current) setState({ status: 'error', date: null, abbreviation: null });
      }
    };

    fetchAuthoritative();
    const refreshInterval = setInterval(fetchAuthoritative, TIME_NOW_REFRESH_MS);
    const tickInterval = setInterval(() => {
      if (!baselineRef.current) return;
      const { unixtimeMs, fetchedAtMs, abbreviation } = baselineRef.current;
      setState({ status: 'ok', date: new Date(unixtimeMs + (Date.now() - fetchedAtMs)), abbreviation });
    }, LOCAL_TICK_MS);

    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
      clearInterval(tickInterval);
    };
  }, [timezone]);

  return state;
}

function AnalogWatchface({ date, timezone, size = 56 }: { date: Date; timezone: string; size?: number }) {
  const { hour, minute } = getZonedHourMinute(date, timezone);
  const hourAngle = (hour % 12) * 30 + minute * 0.5;
  const minuteAngle = minute * 6;
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" className="shrink-0">
      <circle cx="28" cy="28" r="27" className="fill-card stroke-border" strokeWidth="1" />
      {[0, 90, 180, 270].map((deg) => (
        <line key={deg} x1="28" y1="4" x2="28" y2="7" strokeWidth="1.5" strokeLinecap="round" className="stroke-muted-foreground" transform={`rotate(${deg} 28 28)`} />
      ))}
      <line x1="28" y1="28" x2="28" y2="14" strokeWidth="2.5" strokeLinecap="round" className="stroke-foreground" transform={`rotate(${hourAngle} 28 28)`} />
      <line x1="28" y1="28" x2="28" y2="9" strokeWidth="1.75" strokeLinecap="round" className="stroke-foreground/70" transform={`rotate(${minuteAngle} 28 28)`} />
      <circle cx="28" cy="28" r="1.75" className="fill-primary" />
    </svg>
  );
}

function PamClockCard({ pam }: { pam: User }) {
  const clock = usePamClock(pam.timezone ?? null);

  if (clock.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-1.5 w-[84px] text-center">
        <div className="h-14 w-14 rounded-full border border-dashed border-border/60 flex items-center justify-center text-[10px] text-muted-foreground">--</div>
        <p className="text-xs text-muted-foreground truncate w-full">{pam.location_label}</p>
        <p className="text-[11px] text-muted-foreground/70">Unavailable</p>
      </div>
    );
  }

  if (clock.status === 'loading' || !clock.date) {
    return (
      <div className="flex flex-col items-center gap-1.5 w-[84px]">
        <Skeleton className="h-14 w-14 rounded-full" />
        <Skeleton className="h-3 w-16" />
      </div>
    );
  }

  const { hour } = getZonedHourMinute(clock.date, pam.timezone!);
  const isDaytime = hour >= 7 && hour < 19;
  const digitalTime = new Intl.DateTimeFormat('en-US', { timeZone: pam.timezone!, hour: 'numeric', minute: '2-digit' }).format(clock.date);

  return (
    <div className="flex flex-col items-center gap-1.5 w-[84px] text-center">
      <AnalogWatchface date={clock.date} timezone={pam.timezone!} />
      <p className="text-xs font-medium text-foreground truncate w-full" title={pam.location_label ?? undefined}>{pam.location_label}</p>
      <div className="flex items-center gap-1 text-xs tabular-nums text-foreground">
        {isDaytime ? <Sun className="h-3 w-3 text-amber-500" /> : <Moon className="h-3 w-3 text-indigo-400" />}
        <span>{digitalTime}</span>
        {clock.abbreviation && <span className="text-muted-foreground">{clock.abbreviation}</span>}
      </div>
      <p className="text-[11px] text-muted-foreground truncate w-full">{pam.name}</p>
    </div>
  );
}

// Only PAMs with BOTH location_label and timezone explicitly configured
// render a card -- no placeholder/guessed entries for the rest. Renders
// nothing at all if no PAM has been configured yet.
//
// Phase 11.6B: condensed from a full section (heading + bordered Card +
// separate bordered-top attribution footer) into one compact horizontal
// strip -- moved high on the page (directly below the AI Channel Brief),
// so it can no longer afford the earlier "large, quiet, last thing on the
// page" treatment. Same data, same PamClockCard widget, same attribution
// text -- only the surrounding chrome shrank to a single row.
function PamLocalTimeSection({ users }: { users: User[] | undefined }) {
  const configuredPams = (users ?? []).filter((u) => u.role === 'pam' && u.active && u.location_label && u.timezone);
  if (configuredPams.length === 0) return null;

  return (
    <div className="max-w-5xl flex items-center gap-4 rounded-md border border-border/60 bg-card px-4 py-2.5 overflow-x-auto">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide shrink-0">PAM Local Time</span>
      <div className="flex items-center gap-4 shrink-0">
        {configuredPams.map((pam) => (
          <PamClockCard key={pam.id} pam={pam} />
        ))}
      </div>
      <a
        href="https://time.now"
        target="_blank"
        rel="noreferrer"
        className="text-[10px] text-muted-foreground/60 hover:text-foreground hover:underline ml-auto shrink-0 whitespace-nowrap"
      >
        World Time API by Time.Now
      </a>
    </div>
  );
}

// Phase 11.3: presentation-only, frontend-only identity check for the
// "Aniri's Office" subtitle -- matched on the stable, server-issued
// activeUser.email (never a free-text display name, never role alone,
// which is shared by every Head/Admin). irina.dochitu@druidai.com is the
// real seeded identity for this role (see api-server/src/scripts/seed.ts),
// not an invented address. No backend change, no new permission system --
// this affects nothing but which subtitle string renders.
const ANIRI_OFFICE_EMAIL = 'irina.dochitu@druidai.com';

export default function Overview() {
  const { user: activeUser, isGlobalUser } = useAuth();
  const isAniriOffice = activeUser?.email?.toLowerCase() === ANIRI_OFFICE_EMAIL;
  // Mirrors backend requireAdmin's ADMIN_ROLES exactly (head_of_channels,
  // admin) -- kept as its own explicit check rather than reusing
  // isGlobalUser, since that flag's definition is about territory scoping
  // in general and target-edit permission should stay pinned to this exact
  // role set regardless of how isGlobalUser evolves elsewhere.
  const canEditTargets = activeUser?.role === 'head_of_channels' || activeUser?.role === 'admin';
  // Same role set as canEditTargets, but kept as its own explicit check --
  // this one gates GET /users (requireAdmin) for PAM Local Time, a
  // separate concern that shouldn't silently start tracking canEditTargets
  // if that check's definition ever changes.
  const canViewTeamData = activeUser?.role === 'head_of_channels' || activeUser?.role === 'admin';
  // Phase 8: Overview is the Head/Admin management reporting hub -- an
  // internal "Weekly Team" view alongside the existing "Performance" view,
  // driven by a ?view= query param (never a separate route/nav item, and
  // never available to a PAM: Team Weekly Report is Head/Admin-only, same
  // as before this relocation).
  const locationSearch = useSearch();
  const [, setLocation] = useLocation();
  const view: 'performance' | 'weekly-team' =
    isGlobalUser && new URLSearchParams(locationSearch).get('view') === 'weekly-team' ? 'weekly-team' : 'performance';
  const setView = (next: 'performance' | 'weekly-team') => setLocation(next === 'performance' ? '/' : '/?view=weekly-team');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: territories } = useListTerritories();
  const ownTerritoryId = !isGlobalUser
    ? territories?.find((t) => t.name === activeUser?.territory)?.id
    : undefined;
  const [territory, setTerritory] = useState<string>('global');
  const [period, setPeriod] = useState<string>(getDefaultPeriodKey());
  const [currency, setCurrency] = useState<Currency>('USD');
  const [selectedKpi, setSelectedKpi] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingManagement, setIsExportingManagement] = useState(false);
  const [editTargetOpen, setEditTargetOpen] = useState(false);
  const [targetValueInput, setTargetValueInput] = useState('');
  const [targetNoteInput, setTargetNoteInput] = useState('');
  const [confirmingClear, setConfirmingClear] = useState(false);

  // PAMs only ever see their own territory's KPIs -- the server enforces
  // this too, but default the selector to it so there's nothing to pick.
  useEffect(() => {
    if (ownTerritoryId && territory === 'global') {
      setTerritory(ownTerritoryId);
    }
  }, [ownTerritoryId]);

  const scopedTerritory = territory === 'global' ? null : territory;
  // Stage 6.2: targets are canonically PAM-scoped. Global has no single
  // accountable PAM, and neither does a territory with no canonical owner
  // -- editing is only offered when one resolves, derived from the same
  // territories.owner_user_id source of truth as everywhere else (never
  // users.territory free text, never a second PAM picker in this dialog).
  const targetPamUserId = scopedTerritory ? territories?.find((t) => t.id === scopedTerritory)?.owner_user_id ?? null : null;

  const { data: kpis, isLoading: isLoadingKpis } = useGetHeadOfChannelsKpis({
    territory: scopedTerritory,
    period,
    currency,
  });
  const detailParams = { metric_key: selectedKpi ?? '', territory: scopedTerritory, period, currency };
  const { data: detail, isLoading: isLoadingDetail } = useGetKpiDetails(
    detailParams,
    { query: { enabled: Boolean(selectedKpi), queryKey: getGetKpiDetailsQueryKey(detailParams) } },
  );

  // Only fetched for the edit-target dialog (id/note aren't part of
  // GetKpiDetails) -- gated to global users since a PAM never edits.
  const targetsParams = { metric_key: selectedKpi ?? '' };
  const { data: targetRows } = useListMetricTargets(targetsParams, {
    query: { enabled: canEditTargets && Boolean(selectedKpi), queryKey: getListMetricTargetsQueryKey(targetsParams) },
  });
  const existingTarget = findExistingTarget(targetRows, scopedTerritory, period, targetPamUserId);

  const invalidateKpiQueries = () => {
    queryClient.invalidateQueries({ queryKey: getGetHeadOfChannelsKpisQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetKpiDetailsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListMetricTargetsQueryKey() });
    // Targets feed the AI brief's generation-input hash too -- a saved/
    // cleared target can flip a cached brief to stale immediately.
    queryClient.invalidateQueries({ queryKey: getGetAiChannelBriefQueryKey() });
  };

  // Cache-only read on mount/filter change -- generation is exclusively
  // user-triggered via the Regenerate button below, never automatic.
  // Role-separation hotfix: AI Channel Brief is Head-of-Channels/Admin-only
  // (see routes/ai_channel_brief.ts) -- a PAM's Overview must never even
  // call the now-403'ing endpoint, not just hide the resulting panel.
  const aiBriefParams = { territory: scopedTerritory, period, currency };
  const { data: aiBrief, isLoading: isLoadingAiBrief } = useGetAiChannelBrief(aiBriefParams, {
    query: { enabled: isGlobalUser, queryKey: getGetAiChannelBriefQueryKey(aiBriefParams) },
  });

  const regenerateAiBriefMutation = useRegenerateAiChannelBrief({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetAiChannelBriefQueryKey(aiBriefParams), data);
      },
      onError: (err) => {
        const description = err instanceof ApiError && err.message ? err.message : 'Could not generate the brief. Please try again.';
        toast({ variant: 'destructive', title: 'AI brief generation failed', description });
      },
    },
  });

  const handleRegenerateAiBrief = () => {
    regenerateAiBriefMutation.mutate({
      data: { territory: scopedTerritory, period: period as KpiPeriod, currency },
    });
  };

  const { data: teamUsers } = useListUsers({ query: { enabled: canViewTeamData, queryKey: getListUsersQueryKey() } });

  // Best-effort metric_key -> human label, built from whatever's currently
  // loaded for this exact period/territory/currency scope (so it always
  // matches the AI brief's own scope). Falls back to the raw key.
  const metricLabelByKey = useMemo(() => {
    const map = new Map<string, string>();
    if (kpis) {
      for (const row of [...kpis.partner_development, ...kpis.weekly_commercial, ...kpis.weekly_marketing]) {
        map.set(row.metric_key, row.metric);
      }
    }
    return map;
  }, [kpis]);

  const upsertTargetMutation = useUpsertMetricTarget({
    mutation: {
      onSuccess: () => {
        invalidateKpiQueries();
        setEditTargetOpen(false);
        toast({ title: 'Target saved' });
      },
      onError: () => {
        toast({ variant: 'destructive', title: 'Could not save target', description: 'Please try again.' });
      },
    },
  });

  const deleteTargetMutation = useDeleteMetricTarget({
    mutation: {
      onSuccess: () => {
        invalidateKpiQueries();
        setEditTargetOpen(false);
        toast({ title: 'Target cleared', description: 'This KPI has no configured target again.' });
      },
      onError: () => {
        toast({ variant: 'destructive', title: 'Could not clear target', description: 'Please try again.' });
      },
    },
  });

  // No KPI in this product has a meaningful negative target (all are
  // counts or money-pipeline goals), so negative values are rejected
  // alongside non-finite ones -- shown inline rather than silently ignored.
  const parsedTargetValue = targetValueInput.trim() === '' ? null : Number(targetValueInput);
  const targetValueError =
    targetValueInput.trim() === ''
      ? null
      : !Number.isFinite(parsedTargetValue)
        ? 'Enter a valid number.'
        : parsedTargetValue! < 0
          ? 'Target cannot be negative.'
          : null;
  const isTargetValueValid = parsedTargetValue !== null && targetValueError === null;

  const openEditTarget = () => {
    setTargetValueInput(existingTarget ? String(existingTarget.target_value) : '');
    setTargetNoteInput(existingTarget?.note ?? '');
    setConfirmingClear(false);
    setEditTargetOpen(true);
  };

  const handleSaveTarget = () => {
    if (!selectedKpi || !isTargetValueValid || parsedTargetValue === null || !scopedTerritory || !targetPamUserId) return;
    upsertTargetMutation.mutate({
      data: {
        metric_key: selectedKpi,
        period: period as KpiPeriod,
        territory_id: scopedTerritory,
        pam_user_id: targetPamUserId,
        target_value: parsedTargetValue,
        note: targetNoteInput.trim() || null,
      },
    });
  };

  const handleClearTarget = () => {
    if (!existingTarget) return;
    deleteTargetMutation.mutate({ id: existingTarget.id });
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const blob = await exportQuarterlyPptx({ territory: scopedTerritory, period, currency });
      const territoryLabel = territory === 'global' ? 'global' : (territories?.find((t) => t.id === territory)?.name ?? territory);
      const fileName = `partner-radar-${period}-${territoryLabel.toLowerCase().replace(/\s+/g, '-')}.pptx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Export ready', description: 'Your PowerPoint report has downloaded.' });
    } catch (err) {
      let description = 'Something went wrong generating the report. Please try again.';
      if (err instanceof ApiError) {
        if (err.status === 400) description = err.message || 'Invalid export request -- check the selected period, territory, or currency.';
        else if (err.status === 403) description = 'You do not have access to export this territory.';
        else if (err.status === 503) description = 'The exchange rate is temporarily unavailable. Try again shortly, or export in USD.';
        else description = err.message || description;
      }
      toast({ title: 'Export failed', description, variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  // Phase 8: the management report deck -- built server-side from the exact
  // same payload GET /reporting/management/summary returns, so it is never
  // a Performance-view-only or Weekly-Team-view-only export; available from
  // either view, per the "PPT export is an Overview action, not a
  // navigation destination" instruction.
  const handleExportManagement = async () => {
    setIsExportingManagement(true);
    try {
      const blob = await exportManagementPptx({ territory: scopedTerritory, currency });
      const territoryLabel = territory === 'global' ? 'global' : (territories?.find((t) => t.id === territory)?.name ?? territory);
      const fileName = `druid-management-report-${territoryLabel.toLowerCase().replace(/\s+/g, '-')}.pptx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast({ title: 'Export ready', description: 'Your management report has downloaded.' });
    } catch (err) {
      let description = 'Something went wrong generating the report. Please try again.';
      if (err instanceof ApiError) {
        if (err.status === 400) description = err.message || 'Invalid export request -- check the selected territory or currency.';
        else if (err.status === 403) description = 'You do not have access to export this territory.';
        else if (err.status === 503) description = 'The exchange rate is temporarily unavailable. Try again shortly, or export in USD.';
        else description = err.message || description;
      }
      toast({ title: 'Export failed', description, variant: 'destructive' });
    } finally {
      setIsExportingManagement(false);
    }
  };

  // Shared chrome for both the Performance and Weekly Team views -- period/
  // territory/currency selectors are Performance-specific (Weekly Team has
  // its own week selector), but the view switcher and both PPT export
  // actions apply regardless of which view is active.
  const headerRow = (
    <PageHeader
      title="Overview"
      description={
        isAniriOffice
          ? "Aniri's Office · Channel intelligence workspace"
          : (view === 'weekly-team' ? 'Weekly PAM reporting, team-wide.' : 'Global partner development and channel performance.')
      }
      actions={
      <div className="flex items-center gap-3 flex-wrap">
        {isGlobalUser && (
          <Tabs value={view} onValueChange={(v) => setView(v as 'performance' | 'weekly-team')}>
            <TabsList>
              <TabsTrigger value="performance" data-testid="tab-performance">Performance</TabsTrigger>
              <TabsTrigger value="weekly-team" data-testid="tab-weekly-team">Weekly Team</TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        {/* Phase 11.2: My Weekly Report is PAM self-service, not
            management oversight (see audit) -- it stays its own route with
            its own submission flow, untouched. This is only a navigational
            affordance so it's reachable from the PAM's operational home
            instead of an isolated sidebar item: selecting the tab navigates
            to the existing /my-weekly-report route, it never renders that
            page's content inline the way Weekly Team does above. */}
        {!isGlobalUser && (
          <Tabs value="overview" onValueChange={(v) => v === 'my-weekly-report' && setLocation('/my-weekly-report')}>
            <TabsList>
              <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
              <TabsTrigger value="my-weekly-report" data-testid="tab-my-weekly-report">My Weekly Report</TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        {view === 'performance' && (
          <>
            <PeriodSelector value={period} onChange={setPeriod} />

            <Select value={territory} onValueChange={setTerritory}>
              <SelectTrigger className="w-[200px] bg-card">
                <SelectValue placeholder="Territory" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global (All)</SelectItem>
                {territories?.map(t => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
              <SelectTrigger className="w-[110px] bg-card" data-testid="select-currency">
                <SelectValue placeholder="Currency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD ($)</SelectItem>
                <SelectItem value="EUR">EUR (€)</SelectItem>
                <SelectItem value="GBP">GBP (£)</SelectItem>
              </SelectContent>
            </Select>

          </>
        )}

        {/* Phase 11.3: the quarterly PPTX (Performance-view only) and the
            Phase 8 management report export were two separate always-visible
            buttons -- consolidated into one Export control. Same handlers,
            same role gate (Head/Admin-only, see routes/exports.ts), same
            availability (management report from either view; quarterly PPTX
            only while Performance is the active view). */}
        {isGlobalUser && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="bg-card" disabled={isExporting || isExportingManagement}>
                {isExporting || isExportingManagement ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                {isExporting || isExportingManagement ? 'Exporting…' : 'Export'}
                <ChevronDown className="h-4 w-4 ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={view !== 'performance' || isExporting}
                onClick={handleExport}
                data-testid="button-export-pptx"
              >
                Quarterly PowerPoint
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isExportingManagement}
                onClick={handleExportManagement}
                data-testid="button-export-management-pptx"
              >
                Management Report
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      }
    />
  );

  if (view === 'weekly-team') {
    return (
      <div className="flex h-full w-full relative">
        <div className="flex-1 p-6 space-y-6 overflow-auto">
          {headerRow}
          <WeeklyTeamView />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full relative">
      <div className="flex-1 p-6 space-y-6 overflow-auto">
        {headerRow}

        {/* Phase 4: PAM-only action queue, prominent at the top of the PAM's
            own Overview -- the Head of Channels Overview is unchanged. */}
        {!isGlobalUser && <PamActionQueue />}

        {/* Phase 11.6B: AI Channel Brief and PAM Local Time moved here --
            high on the page, directly after the header/action-queue tier
            and before any KPI/commercial data ("what should I know" and
            "what's the regional context" ahead of "what are the numbers",
            per the explicit product requirement). Neither is nested inside
            the `kpis ?` branch below, so both keep rendering (with their
            own independent loading/empty states) regardless of KPI load
            state -- unchanged from before this move, only the position
            changed. */}
        {isGlobalUser && (
          <div className="max-w-5xl">
            <AiChannelBriefPanel
              brief={aiBrief}
              isLoading={isLoadingAiBrief}
              onRegenerate={handleRegenerateAiBrief}
              isRegenerating={regenerateAiBriefMutation.isPending}
              metricLabelByKey={metricLabelByKey}
            />
          </div>
        )}

        {canViewTeamData && <PamLocalTimeSection users={teamUsers} />}

        {/* Phase 5B-1: Irina annual target -> quarterly PAM allocations ->
            partner opportunities -> pipeline/closed revenue/attainment.
            Head/Admin get the full cascade + allocation management; a PAM
            gets a compact read-only block scoped to their own quarter (see
            components/commercial-performance.tsx for why each role reads
            from a different, already-role-scoped backend endpoint). */}
        {isGlobalUser ? (
          <CommercialPerformanceHead weeklyCommercial={kpis?.weekly_commercial} year={splitPeriodKey(period)?.year ?? getCurrentYear()} currency={currency} />
        ) : (
          <CommercialPerformancePam weeklyCommercial={kpis?.weekly_commercial} currency={currency} />
        )}

        {isLoadingKpis ? (
          <div className="space-y-6">
            <Skeleton className="h-[200px] w-full rounded-md" />
            <Skeleton className="h-[200px] w-full rounded-md" />
            <Skeleton className="h-[200px] w-full rounded-md" />
          </div>
        ) : kpis ? (
          <div className="space-y-6 max-w-5xl">
            <section className="space-y-3">
              <h2 className="text-section-title">Core Channel Performance</h2>

              {/* Phase 11.3: the 3 tables below were 3 separate, equally-
                  weighted Cards (each with its own bordered+shaded header) --
                  now one Card with divided sections and a lighter inline
                  header per section, so they read as one KPI review rather
                  than 3 competing panels. Data/columns/click-through to the
                  detail slide-over are untouched. Phase 11.6B: Card ->
                  SectionCard (11.6A foundation), same rendered classes. */}
              <SectionCard className="divide-y divide-border/60">
                {/* Table 1: Partner development */}
                <div>
                  <div className="flex items-center gap-2 px-5 py-3">
                    <h3 className="text-sm font-medium text-foreground">Partner development</h3>
                    <CoreBadge />
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[250px] font-medium text-muted-foreground">KPI</TableHead>
                        <TableHead className="font-medium text-muted-foreground text-right">Current</TableHead>
                        <TableHead className="font-medium text-muted-foreground text-right">Target</TableHead>
                        <TableHead className="font-medium text-muted-foreground">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {kpis.partner_development.map((row, i) => (
                        <TableRow
                          key={i}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => setSelectedKpi(row.metric_key)}
                        >
                          <TableCell className="font-medium">{row.metric}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMetricValue(row.current, row.metric_key, currency)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{formatMetricValue(row.target, row.metric_key, currency)}</TableCell>
                          <TableCell><StatusBadge status={row.status} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Table 2: Weekly commercial performance -- Current / Last Week / Target / Trend */}
                <div>
                  <div className="flex items-center gap-2 px-5 py-3">
                    <h3 className="text-sm font-medium text-foreground">Weekly commercial performance</h3>
                    <CoreBadge />
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[250px] font-medium text-muted-foreground">Metric</TableHead>
                        <TableHead className="font-medium text-muted-foreground text-right">Current</TableHead>
                        <TableHead className="font-medium text-muted-foreground text-right">Last Week</TableHead>
                        <TableHead className="font-medium text-muted-foreground text-right">Target</TableHead>
                        <TableHead className="font-medium text-muted-foreground">Trend</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {kpis.weekly_commercial.map((row, i) => (
                        <TableRow
                          key={i}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => setSelectedKpi(row.metric_key)}
                        >
                          <TableCell className="font-medium">{row.metric}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMetricValue(row.current, row.metric_key, currency)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{formatMetricValue(row.last_week, row.metric_key, currency)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{formatMetricValue(row.target, row.metric_key, currency)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <TrendIcon trend={row.trend} />
                              <span className="text-sm capitalize">{formatTrendLabel(row.trend)}</span>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Table 3: Weekly channel marketing -- This Week / Trend only, no visible Last Week (locked semantics) */}
                <div>
                  <div className="flex items-center gap-2 px-5 py-3">
                    <h3 className="text-sm font-medium text-foreground">Weekly channel marketing</h3>
                    <CoreBadge />
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[220px] font-medium text-muted-foreground">Metric</TableHead>
                        <TableHead className="font-medium text-muted-foreground text-right">This Week</TableHead>
                        <TableHead className="font-medium text-muted-foreground">Trend</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {kpis.weekly_marketing.map((row, i) => (
                        <TableRow
                          key={i}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => setSelectedKpi(row.metric_key)}
                        >
                          <TableCell className="font-medium">{row.metric}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMetricValue(row.this_week, row.metric_key, currency)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <TrendIcon trend={row.trend} />
                              <span className="text-sm capitalize">{formatTrendLabel(row.trend)}</span>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </SectionCard>
            </section>
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground">No data available.</div>
        )}
      </div>

      {/* Right Side Slide-over Panel for Details */}
      {selectedKpi && (
        <div className="w-[420px] border-l border-border/50 bg-card flex flex-col h-full shadow-[-10px_0_30px_rgba(0,0,0,0.03)] transition-transform duration-300">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 bg-muted/10">
            <h3 className="font-medium">{detail?.metric ?? 'Metric'} details</h3>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => setSelectedKpi(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-5 space-y-6">
              {isLoadingDetail ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : detail ? (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <DataStatusBadge status={detail.data_status} />
                      <StatusBadge status={detail.status ?? null} />
                    </div>
                    {detail.reconciles === false && (
                      <Badge variant="outline" className="text-rose-700 bg-rose-50 border-rose-200 font-normal text-xs">Reconciliation mismatch</Badge>
                    )}
                  </div>

                  {/* Current / actual-to-date, target-to-date, dynamic full-period target, variance */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Current</p>
                      <p className="text-lg font-semibold tabular-nums">{formatMetricValue(detail.current, detail.metric_key, currency)}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Target-to-date</p>
                      <p className="text-lg font-semibold tabular-nums">{formatMetricValue(detail.target_to_date, detail.metric_key, currency)}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-muted-foreground uppercase tracking-wider">{detail.full_period_target_label}</p>
                        {canEditTargets && targetPamUserId && (
                          <button
                            type="button"
                            onClick={openEditTarget}
                            className="text-muted-foreground hover:text-foreground -mr-1 -mt-1 p-1 rounded"
                            aria-label="Edit target"
                            data-testid="button-edit-target"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      <p className="text-lg font-semibold tabular-nums">{formatMetricValue(detail.full_period_target, detail.metric_key, currency)}</p>
                    </div>
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Variance</p>
                      <p className={cn(
                        'text-lg font-semibold tabular-nums',
                        detail.variance !== null && detail.variance !== undefined && (detail.variance >= 0 ? 'text-emerald-600' : 'text-rose-600'),
                      )}>
                        {formatMetricValue(detail.variance, detail.metric_key, currency)}
                      </p>
                    </div>
                  </div>

                  {/* Last Week / Trend -- present only for metrics that carry them (commercial-shaped metrics) */}
                  {(detail.last_week !== null && detail.last_week !== undefined || detail.trend) && (
                    <div className="flex items-center gap-5 text-sm rounded-md border border-border/60 p-3">
                      <span className="text-muted-foreground">
                        Last week: <span className="text-foreground font-medium tabular-nums">{formatMetricValue(detail.last_week, detail.metric_key, currency)}</span>
                      </span>
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        Trend: <TrendIcon trend={detail.trend ?? null} /> <span className="capitalize text-foreground">{formatTrendLabel(detail.trend)}</span>
                      </span>
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2 uppercase tracking-wider">Explanation</h4>
                    <div className="space-y-2">
                      <p className="text-sm leading-relaxed text-foreground">{detail.explanation}</p>
                      {detail.what_changed && (
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          <span className="font-medium text-foreground">What changed: </span>{detail.what_changed}
                        </p>
                      )}
                      {detail.reconciliation_note && (
                        <p className="text-sm leading-relaxed text-rose-700">{detail.reconciliation_note}</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Territory Breakdown</h4>
                    {detail.by_territory.length > 0 ? (
                      <div className="rounded-md border border-border/60 overflow-hidden">
                        <Table>
                          <TableHeader className="bg-muted/20">
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="py-2 h-9 text-xs">Territory</TableHead>
                              <TableHead className="py-2 h-9 text-xs text-right">Contribution</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.by_territory.map((t, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/30">
                                <TableCell className="py-2 text-sm">{t.territory_name}</TableCell>
                                <TableCell className="py-2 text-sm text-right font-medium tabular-nums">{formatMetricValue(t.value, detail.metric_key, currency)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No territory breakdown available for this metric.</p>
                    )}
                  </div>

                  {/* PAM contribution -- territories.owner_user_id resolved server-side; never a synthetic row without a real territory */}
                  {detail.pam_contribution.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">PAM contribution</h4>
                      <div className="rounded-md border border-border/60 overflow-hidden">
                        <Table>
                          <TableHeader className="bg-muted/20">
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="py-2 h-9 text-xs">Territory</TableHead>
                              <TableHead className="py-2 h-9 text-xs">PAM</TableHead>
                              <TableHead className="py-2 h-9 text-xs text-right">Value</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.pam_contribution.map((p, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/30">
                                <TableCell className="py-2 text-sm">{p.territory_name}</TableCell>
                                <TableCell className="py-2 text-sm text-muted-foreground">{p.pam_name ?? 'Unassigned'}</TableCell>
                                <TableCell className="py-2 text-sm text-right font-medium tabular-nums">{formatMetricValue(p.value, detail.metric_key, currency)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {detail.records.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wider">Underlying records</h4>
                      <div className="rounded-md border border-border/60 overflow-hidden max-h-64 overflow-y-auto">
                        <Table>
                          <TableBody>
                            {detail.records.map((r, idx) => (
                              <TableRow key={idx} className="hover:bg-muted/30">
                                <TableCell className="py-2 text-sm">{r.label}</TableCell>
                                <TableCell className="py-2 text-sm text-right text-muted-foreground">{r.date ? new Date(r.date).toLocaleDateString() : '--'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}

                  {(detail.data_source || detail.last_updated || (detail.fx && detail.fx.currency !== 'USD')) && (
                    <div className="rounded-md border border-border/60 bg-muted/10 p-3 space-y-1.5">
                      {detail.data_source && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Data source: </span>{detail.data_source}
                        </p>
                      )}
                      {detail.last_updated && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Last updated: </span>{new Date(detail.last_updated).toLocaleString()}
                        </p>
                      )}
                      {detail.fx && detail.fx.currency !== 'USD' && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Currency: </span>
                          1 USD = {detail.fx.usd_to_currency_rate.toFixed(4)} {detail.fx.currency}
                          {detail.fx.as_of ? ` — Frankfurter reference rate as of ${detail.fx.as_of}` : ''}
                          {detail.fx.stale ? ' (reference rate could not be refreshed; showing the last stored rate)' : ''}
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No details available for this metric.</p>
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      {canEditTargets && (
        <Dialog open={editTargetOpen} onOpenChange={(open) => { setEditTargetOpen(open); if (!open) setConfirmingClear(false); }}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Edit target — {detail?.metric ?? 'KPI'}</DialogTitle>
              <DialogDescription>
                {detail?.period ?? period} · {scopedTerritory ? (detail?.territory ?? territories?.find((t) => t.id === scopedTerritory)?.name) : 'Global'}
                . This only sets the target -- it never changes the actual value, which is computed from its own source.
              </DialogDescription>
            </DialogHeader>
            <div className="py-2 space-y-4">
              <div className="text-sm text-muted-foreground">
                Current actual: <span className="text-foreground font-medium tabular-nums">{formatMetricValue(detail?.current ?? null, detail?.metric_key ?? '', currency)}</span>
              </div>
              <div>
                <Label htmlFor="target-value" className="mb-2 block">Target value</Label>
                <Input
                  id="target-value"
                  type="number"
                  value={targetValueInput}
                  onChange={(e) => setTargetValueInput(e.target.value)}
                  placeholder="e.g. 15"
                  aria-invalid={targetValueError !== null}
                />
                {targetValueError && (
                  <p className="text-xs text-rose-600 mt-1.5">{targetValueError}</p>
                )}
              </div>
              <div>
                <Label htmlFor="target-note" className="mb-2 block">Note (optional)</Label>
                <Textarea
                  id="target-note"
                  value={targetNoteInput}
                  onChange={(e) => setTargetNoteInput(e.target.value)}
                  placeholder="Why this target?"
                />
              </div>

              {confirmingClear && (
                <div className="rounded-md border border-rose-200 bg-rose-50 p-3 space-y-2">
                  <p className="text-sm text-rose-800">
                    Clear this target? This KPI/period/scope will go back to having <span className="font-medium">no configured target</span> -- it will not fall back to any previous or default value.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => setConfirmingClear(false)}>Cancel</Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={handleClearTarget}
                      disabled={deleteTargetMutation.isPending}
                    >
                      Yes, clear target
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter className="flex items-center justify-between sm:justify-between">
              {existingTarget && !confirmingClear ? (
                <Button
                  variant="ghost"
                  className="text-rose-600 hover:text-rose-600 hover:bg-rose-50"
                  onClick={() => setConfirmingClear(true)}
                >
                  Clear target
                </Button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setEditTargetOpen(false)}>Cancel</Button>
                <Button onClick={handleSaveTarget} disabled={upsertTargetMutation.isPending || !isTargetValueValid}>
                  Save target
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
