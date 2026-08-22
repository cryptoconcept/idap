/** Mongo dates are not serialisable across the RSC boundary; ISO strings are. */
export function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function requiredIso(value: Date | string | null | undefined): string {
  return toIso(value) ?? new Date(0).toISOString();
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a date-range clause from user supplied `from`/`to` strings. `to` is
 * pushed to the end of that day so the filter reads inclusively.
 */
export function dateRangeFilter(from?: string, to?: string): Record<string, Date> | undefined {
  const range: Record<string, Date> = {};
  if (from) {
    const start = new Date(from);
    if (!Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      range.$gte = start;
    }
  }
  if (to) {
    const end = new Date(to);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
  }
  return Object.keys(range).length > 0 ? range : undefined;
}
