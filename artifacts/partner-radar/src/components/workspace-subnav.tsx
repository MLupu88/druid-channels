import { useLocation } from 'wouter';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { WorkspaceSubNavItem } from '@/lib/navigation';

// Phase 11.2: a Tabs-as-router-switch, same mechanism Overview already uses
// for its Performance/Weekly Team switcher (Tabs value=<current route>,
// onValueChange navigates) -- just generalized to jump between several real
// routes instead of a query param on one route. Selecting a tab navigates;
// it never swaps content in place, so each destination page's own data
// fetching/state is untouched.
export function WorkspaceSubNav({ items, className }: { items: WorkspaceSubNavItem[]; className?: string }) {
  const [location, setLocation] = useLocation();
  const activeValue = items.find((item) => item.href === location)?.value ?? items[0]?.value;

  return (
    <Tabs
      value={activeValue}
      onValueChange={(value) => {
        const item = items.find((i) => i.value === value);
        if (item) setLocation(item.href);
      }}
      className={className}
    >
      <TabsList>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value} data-testid={`tab-${item.value}`}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
