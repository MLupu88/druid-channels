import type { TerritoryPotentialSummary } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const POTENTIAL_LABEL: Record<TerritoryPotentialSummary['potential_band'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  insufficient_data: 'Insufficient data',
};

const POTENTIAL_STYLE: Record<TerritoryPotentialSummary['potential_band'], string> = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-muted text-muted-foreground border-border',
  insufficient_data: 'bg-muted text-muted-foreground border-border',
};

const SATURATION_LABEL: Record<TerritoryPotentialSummary['saturation_state'], string> = {
  unexplored: 'Unexplored',
  exploring: 'Exploring',
  productive: 'Productive',
  slowing: 'Slowing',
  saturated: 'Saturated',
  insufficient_data: 'Insufficient data',
};

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatYield(y: number | null): string {
  if (y === null) return 'No live discovery run yet';
  return `${Math.round(y * 100)}% new companies`;
}

/**
 * Stage 6.5: a compact, deterministic Territory Potential summary --
 * matches the product spec's example format exactly. All text here is
 * template-based, never DeepSeek-generated (saturation_interpretation is
 * itself pre-computed server-side, see territoryPotentialService.ts).
 *
 * targetFact, when supplied, is a plain deterministic fact cross-referencing
 * the currently-configured target (e.g. "Available qualified pool (12) is
 * below the configured target (20) for New Partner Prospects.") -- never an
 * automated recommendation to change the target.
 *
 * Stage 6.6 audit fix: labeled "Observed Partner Potential" (not "Potential")
 * with explicit helper text -- the low/medium/high band is a count of what
 * DRUID Channels has itself found/qualified so far, never an external
 * market-size estimate (see territoryPotentialService.ts's 10/30 v1
 * thresholds, unchanged by this fix).
 */
export function TerritoryPotentialCard({ summary, targetFact }: { summary: TerritoryPotentialSummary; targetFact?: string | null }) {
  const movedOn = summary.qualified_prospect_count - summary.available_prospect_count;

  return (
    <Card className="shadow-none border-border/60" data-testid={`card-territory-potential-${summary.territory_id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-medium">{summary.territory_name}</CardTitle>
          <Badge variant="outline" className={`font-normal ${POTENTIAL_STYLE[summary.potential_band]}`}>
            Observed Partner Potential: {POTENTIAL_LABEL[summary.potential_band]}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">Discovery state: {SATURATION_LABEL[summary.saturation_state]}</p>
        <p className="text-xs text-muted-foreground/80">
          Based on qualified prospects and existing partners observed in DRUID Channels so far. This is not an external market-size estimate.
        </p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
          <p>{summary.qualified_prospect_count} qualified prospects identified</p>
          <p>{movedOn} already in Recruitment / Portfolio</p>
          <p>{summary.available_prospect_count} currently available prospects</p>
          <p>Recent discovery yield: {formatYield(summary.new_candidate_yield)}</p>
        </div>
        <p className="text-xs text-muted-foreground">Last researched: {formatDate(summary.last_discovery_at)}</p>
        <p className="text-sm pt-1 border-t border-border/40 mt-2">
          <span className="text-muted-foreground">Suggested interpretation: </span>
          {summary.saturation_interpretation}
        </p>
        {targetFact && <p className="text-sm text-amber-700">{targetFact}</p>}
      </CardContent>
    </Card>
  );
}
