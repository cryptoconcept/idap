import { z } from "zod";
import {
  BOARD_NAME_REQUIRED,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_MAX_BANDS,
  RESULT_MAX_TOPPERS,
  RESULT_STREAMS,
  type ResultBoard,
} from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { optionalText, requiredText } from "./common";

const percentage = z.number().min(0, "Must be 0 or more").max(100, "Must be 100 or less");

const bandSchema = z.object({
  label: requiredText("Band label", 40),
  minPercentage: percentage,
  maxPercentage: percentage,
  count: z.number().int().min(0),
});

/**
 * `photoUrl` is deliberately absent. A topper's photo is written only by the
 * upload endpoint; accepting it here would let a caller point the field at
 * another tenant's blob, which is the shape of Phase 1's Critical finding.
 */
const topperSchema = z.object({
  name: requiredText("Topper name", 120),
  percentage,
  rank: z.number().int().min(1).optional(),
  note: optionalText(200),
  consentAcknowledged: z.boolean().optional(),
});

const cycleFields = {
  board: z.enum(RESULT_BOARDS),
  boardName: optionalText(120),
  level: z.enum(RESULT_LEVELS),
  stream: z.enum(RESULT_STREAMS).nullish(),
  academicYear: requiredText("Academic year", 20),
  examLabel: optionalText(120),
};

const outcomeFields = {
  appeared: z.number().int().min(0),
  passed: z.number().int().min(0),
  averageScore: percentage.optional(),
  highestScore: percentage.optional(),
  bands: z.array(bandSchema).max(RESULT_MAX_BANDS).optional(),
  toppers: z.array(topperSchema).max(RESULT_MAX_TOPPERS).optional(),
};

export const createResultSchema = z
  .object({ ...cycleFields, ...outcomeFields })
  // A missing stream becomes an explicit null so the unique cycle index sees
  // one consistent value rather than a mix of null and absent.
  .transform((value) => ({ ...value, stream: value.stream ?? null }));

/**
 * `status` is absent on purpose: a result changes state only through the
 * publish route, so a PATCH can never smuggle a cycle into PUBLISHED and skip
 * the consent gate.
 */
export const updateResultSchema = z.object({
  board: cycleFields.board.optional(),
  boardName: cycleFields.boardName,
  level: cycleFields.level.optional(),
  stream: cycleFields.stream,
  academicYear: requiredText("Academic year", 20).optional(),
  examLabel: cycleFields.examLabel,
  appeared: outcomeFields.appeared.optional(),
  passed: outcomeFields.passed.optional(),
  averageScore: outcomeFields.averageScore,
  highestScore: outcomeFields.highestScore,
  bands: outcomeFields.bands,
  toppers: outcomeFields.toppers,
});

export const resultQuerySchema = z.object({
  academicYear: optionalText(20),
  level: z.enum(RESULT_LEVELS).optional(),
  board: z.enum(RESULT_BOARDS).optional(),
});

export type ResultInvariantInput = {
  board: ResultBoard;
  boardName?: string | null;
  appeared: number;
  passed: number;
  bands?: { label: string; minPercentage: number; maxPercentage: number; count: number }[] | null;
  toppers?: { name: string; percentage?: number; consentAcknowledged?: boolean | null }[] | null;
};

/**
 * Cross-field rules, checked against the MERGED record rather than the request
 * body — a PATCH carrying only `bands` has no `appeared` of its own to compare
 * against, so the service merges first and calls this second.
 */
export function assertResultInvariants(input: ResultInvariantInput): void {
  if (input.passed > input.appeared) {
    throw validationError("passed: the number who passed cannot exceed the number who appeared");
  }

  if (BOARD_NAME_REQUIRED.has(input.board) && !input.boardName?.trim()) {
    throw validationError("boardName: name the board that awarded these results");
  }

  const bands = input.bands ?? [];

  for (const band of bands) {
    if (band.minPercentage > band.maxPercentage) {
      throw validationError(
        `bands: "${band.label}" has a minimum higher than its maximum — the minimum must be lower than or equal to the maximum`,
      );
    }
  }

  const sorted = [...bands].sort((a, b) => a.minPercentage - b.minPercentage);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.minPercentage <= previous.maxPercentage) {
      throw validationError(
        `bands: "${previous.label}" and "${current.label}" overlap — each band must cover a distinct range`,
      );
    }
  }

  const counted = bands.reduce((total, band) => total + band.count, 0);
  if (counted > input.appeared) {
    throw validationError("bands: the bands account for more students than appeared");
  }
}

/**
 * The publish gate. Stricter than `assertResultInvariants`, which a draft may
 * still satisfy while incomplete.
 */
export function assertPublishable(input: ResultInvariantInput): void {
  assertResultInvariants(input);

  if (input.appeared <= 0) {
    throw validationError("appeared: enter how many students appeared before publishing");
  }

  const unconsented = (input.toppers ?? []).filter((topper) => topper.consentAcknowledged !== true);
  if (unconsented.length > 0) {
    const names = unconsented.map((topper) => topper.name).join(", ");
    throw validationError(
      `toppers: confirm consent to publish for ${names} before publishing this result`,
    );
  }
}
