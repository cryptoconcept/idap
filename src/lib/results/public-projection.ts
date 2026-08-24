/**
 * The only path from a Result document to a public response.
 *
 * This is an allow-list: it names the fields that may leave. A field added to
 * the schema is private until someone deliberately adds it here. Rewriting this
 * as a spread with deletions would leak every future field on the day it was
 * added — a test exists specifically to catch that.
 *
 * Two rules live here and nowhere else:
 *
 *  1. Only a PUBLISHED result projects at all. Callers already filter, so this
 *     is defence in depth on the module's highest-risk boundary.
 *  2. A topper without acknowledged consent is dropped. This is NOT redundant
 *     with the publish-time gate: consent can be withdrawn after publication,
 *     and withdrawal must take that topper off the API on the very next read
 *     without the institution having to unpublish the whole cycle.
 */
import { RESULT_BOARD_LABELS, type ResultBoard } from "@/lib/constants";

type Doc = Record<string, unknown>;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const rows = (value: unknown): Doc[] => (Array.isArray(value) ? (value as Doc[]) : []);

/** Drops an array entirely when it has no members, so `[]` never reaches a consumer. */
const listOrUndefined = <T>(values: T[]): T[] | undefined =>
  values.length > 0 ? values : undefined;

export type PublicResult = NonNullable<ReturnType<typeof toPublicResult>>;

export function toPublicResult(result: Doc) {
  const doc = result ?? {};

  if (doc.status !== "PUBLISHED") return null;

  const appeared = num(doc.appeared) ?? 0;
  const passed = num(doc.passed) ?? 0;

  // Computed here and only here. A stored value would drift the moment someone
  // corrected `appeared` or `passed` without recomputing it.
  const passPercentage =
    appeared > 0 ? Math.round((passed / appeared) * 1000) / 10 : null;

  const board = text(doc.board);
  const boardLabel =
    text(doc.boardName) ??
    (board ? RESULT_BOARD_LABELS[board as ResultBoard] ?? board : undefined);

  const bands = rows(doc.bands).map((band) => ({
    label: text(band.label),
    minPercentage: num(band.minPercentage),
    maxPercentage: num(band.maxPercentage),
    count: num(band.count),
  }));

  const toppers = rows(doc.toppers)
    .filter((topper) => topper.consentAcknowledged === true)
    .map((topper) => ({
      name: text(topper.name),
      percentage: num(topper.percentage),
      rank: num(topper.rank),
      note: text(topper.note),
      photoUrl: text(topper.photoUrl),
    }));

  const publishedAt = doc.publishedAt;

  return {
    board,
    boardLabel,
    level: text(doc.level),
    stream: text(doc.stream) ?? null,
    academicYear: text(doc.academicYear),

    appeared,
    passed,
    passPercentage,
    averageScore: num(doc.averageScore),
    highestScore: num(doc.highestScore),

    bands: listOrUndefined(bands),
    toppers: listOrUndefined(toppers),

    publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : text(publishedAt),
  };
}
