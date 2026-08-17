import { useLocation } from 'wouter';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { WorkspaceSubNavItem } from '@/lib/navigation';

// Phase 11.2: a Tabs-as-router-switch, same mechanism Overview's PAM-facing
// "Overview / My Weekly Report" tabs use (Tabs value=<current route>,
// onValueChange navigates) -- generalized here to jump between several real
// Reporting routes. Selecting a tab navigates; it never swaps content in
// place, so each destination page's own data fetching/state is untouched.
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
      {/* overflow-x-auto: TabsList doesn't wrap -- on a narrow viewport
          (mobile drawer sidebar) 4 tabs can exceed the content width, so it
          scrolls horizontally instead of overflowing the page. */}
      <div className="overflow-x-auto">
        <TabsList>
          {items.map((item) => (
            <TabsTrigger key={item.value} value={item.value} data-testid={`tab-${item.value}`}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );
}
