import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * URL-driven tabs. Keeping the selection in the query string means each tab is
 * server rendered and linkable, with no client state to fall out of sync.
 */
export function TabLinks({
  tabs,
  active,
  basePath,
}: {
  tabs: { value: string; label: string; count?: number }[];
  active: string;
  basePath: string;
}) {
  return (
    <div
      role="tablist"
      className="flex items-center gap-1 overflow-x-auto border-b border-border"
    >
      {tabs.map((tab) => {
        const isActive = tab.value === active;
        const href = tab.value === tabs[0]?.value ? basePath : `${basePath}?tab=${tab.value}`;

        return (
          <Link
            key={tab.value}
            href={href}
            role="tab"
            aria-selected={isActive}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              isActive
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="tabular text-[11px] text-muted-foreground">{tab.count}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
