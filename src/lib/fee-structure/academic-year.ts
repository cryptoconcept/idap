const ACADEMIC_YEAR_PATTERN = /^(\d{4})-(\d{2})$/;

/**
 * One year ahead of whichever existing year reaches furthest out, so the
 * create form always offers a ready-to-use option for a cycle nothing has
 * been priced for yet. Falls back to today's date only when no existing year
 * parses as `YYYY-YY` (a first-ever fee structure, or years typed in some
 * other format) — academic years here run April to March, so a date from
 * April onward belongs to the cycle starting this calendar year.
 */
export function suggestNextAcademicYear(existingYears: string[], now: Date = new Date()): string {
  const parsedStarts = existingYears
    .map((year) => year.match(ACADEMIC_YEAR_PATTERN))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number(match[1]));

  const startYear =
    parsedStarts.length > 0
      ? Math.max(...parsedStarts) + 1
      : now.getMonth() >= 3
        ? now.getFullYear()
        : now.getFullYear() - 1;

  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
