"use client";

import { useCallback, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type FilterOption = { value: string; label: string };
export type FilterDefinition = {
  key: string;
  label: string;
  options: FilterOption[];
};

const ALL = "__all__";

/**
 * Filters live in the URL so every list view is shareable, bookmarkable and
 * server-rendered from the same source of truth.
 */
export function FilterBar({
  searchPlaceholder,
  filters,
  showDateRange = true,
}: {
  searchPlaceholder: string;
  filters: FilterDefinition[];
  showDateRange?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const [syncedQuery, setSyncedQuery] = useState(urlQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adjust the input during render when the URL changes from elsewhere — the
  // Clear button, back/forward, or a link into a pre-filtered view.
  if (urlQuery !== syncedQuery) {
    setSyncedQuery(urlQuery);
    setQuery(urlQuery);
  }

  const pushParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      params.delete("page");
      router.push(`${pathname}${params.toString() ? `?${params}` : ""}`);
    },
    [pathname, router, searchParams],
  );

  function onSearchChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushParams((params) => {
        if (value.trim()) params.set("q", value.trim());
        else params.delete("q");
      });
    }, 350);
  }

  const activeCount = [...searchParams.keys()].filter(
    (key) => key !== "page" && searchParams.get(key),
  ).length;

  return (
    <div className="flex flex-col gap-2.5 lg:flex-row lg:flex-wrap lg:items-center">
      <div className="relative min-w-0 flex-1 lg:max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="pl-8"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {filters.map((filter) => (
          <Select
            key={filter.key}
            value={searchParams.get(filter.key) ?? ALL}
            onValueChange={(value) =>
              pushParams((params) => {
                if (value === ALL) params.delete(filter.key);
                else params.set(filter.key, value);
              })
            }
          >
            <SelectTrigger size="sm" className="min-w-[130px]" aria-label={filter.label}>
              <SelectValue placeholder={filter.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{filter.label}: all</SelectItem>
              {filter.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}

        {showDateRange ? (
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              aria-label="From date"
              value={searchParams.get("from") ?? ""}
              onChange={(event) =>
                pushParams((params) => {
                  if (event.target.value) params.set("from", event.target.value);
                  else params.delete("from");
                })
              }
              className="h-8 w-[142px] text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              aria-label="To date"
              value={searchParams.get("to") ?? ""}
              onChange={(event) =>
                pushParams((params) => {
                  if (event.target.value) params.set("to", event.target.value);
                  else params.delete("to");
                })
              }
              className="h-8 w-[142px] text-xs"
            />
          </div>
        ) : null}

        {activeCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => router.push(pathname)}
          >
            <X className="size-3.5" />
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
