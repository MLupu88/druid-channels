import React, { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Search as SearchIcon } from 'lucide-react';
import { useSearch, getSearchQueryKey, type SearchResult } from '@workspace/api-client-react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';

const MODULE_GROUP_LABELS: Record<SearchResult['module'], string> = {
  portfolio: 'Portfolio',
  recruitment: 'Recruitment',
  discovery: 'Discovery',
  radar: 'Channel Radar',
};

const MIN_QUERY_LENGTH = 2;

/**
 * Stage 6.3: replaces the previously non-functional header search input.
 * A command-palette dialog (Radix Dialog under the hood, via cmdk) --
 * Escape/focus handling comes for free from CommandDialog. Real internal
 * application search (companies/portfolio/recruitment/discovery/radar),
 * never Tavily/DeepSeek.
 */
export function SearchTrigger() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [, setLocation] = useLocation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const trimmed = query.trim();
  const enabled = trimmed.length >= MIN_QUERY_LENGTH;
  const { data: results, isFetching } = useSearch(
    { q: trimmed },
    { query: { enabled, queryKey: getSearchQueryKey({ q: trimmed }) } },
  );

  const grouped = (results ?? []).reduce<Record<string, SearchResult[]>>((acc, r) => {
    (acc[r.module] ??= []).push(r);
    return acc;
  }, {});

  const handleSelect = (href: string) => {
    setOpen(false);
    setQuery('');
    setLocation(href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <SearchIcon className="h-4 w-4 shrink-0" />
        <span className="truncate">Search companies, partners, prospects...</span>
        <kbd className="ml-auto hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Search companies, partners, prospects..." value={query} onValueChange={setQuery} />
        <CommandList>
          {!enabled && <div className="py-6 text-center text-sm text-muted-foreground">Type at least {MIN_QUERY_LENGTH} characters to search.</div>}
          {enabled && !isFetching && (results?.length ?? 0) === 0 && <CommandEmpty>No results for "{trimmed}".</CommandEmpty>}
          {(Object.keys(grouped) as SearchResult['module'][]).map((module) => (
            <CommandGroup key={module} heading={MODULE_GROUP_LABELS[module]}>
              {grouped[module]!.map((r) => (
                <CommandItem key={`${r.module}-${r.id}`} value={`${r.module}-${r.id}-${r.company_name}`} onSelect={() => handleSelect(r.href)}>
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium truncate">{r.company_name}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {r.context_label}
                      {r.territory_name ? ` · ${r.territory_name}` : ''}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  );
}
