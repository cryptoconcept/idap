import { z } from "zod";
import {
  BOARD_NAME_REQUIRED,
  EXAM_CODES,
  RECRUITER_CATEGORIES,
  RESULT_BOARDS,
  RESULT_LEVELS,
  RESULT_MAX_BANDS,
  RESULT_MAX_COMBINATIONS,
  RESULT_MAX_RECRUITERS,
  RESULT_MAX_SELECTIONS,
  RESULT_MAX_TOPPERS,
  RESULT_STREAMS,
  type ExamCode,
  type ResultBoard,
} from "@/lib/constants";
import { validationError } from "@/lib/api/errors";
import { objectIdString, optionalText, requiredText } from "./common";

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
 *
 * `id` names an existing topper on this result, so an edit to the list can be
 * matched back to the row it came from. It is a handle, not a field: the
 * service uses it to carry that topper's `_id` and its uploaded `photoUrl`
 * across, and an id matching nothing is simply a new topper. It does NOT let a
 * caller set either of those — that remains the upload endpoint's alone.
 */
const topperSchema = z.object({
  id: z.string().optional(),
  name: requiredText("Topper name", 120),
  percentage,
  rank: z.number().int().min(1).optional(),
  note: optionalText(200),
  consentAcknowledged: z.boolean().optional(),
});

const gradeCountsSchema = z.object({
  "90+": z.number().int().min(0).optional(),
  "80-90": z.number().int().min(0).optional(),
  "70-80": z.number().int().min(0).optional(),
  "60-70": z.number().int().min(0).optional(),
  "50-60": z.number().int().min(0).optional(),
  below50: z.number().int().min(0).optional(),
});

const cohortSplitSchema = z.object({
  appeared: z.number().int().min(0).optional(),
  passed: z.number().int().min(0).optional(),
});

/**
 * `id` names an existing combination on this result, exactly like
 * `topperSchema.id` names an existing topper — a handle the service uses to
 * find the row to merge into, never a field the caller can otherwise set.
 */
export const combinationSchema = z.object({
  id: z.string().optional(),
  academicUnitId: objectIdString.optional(),
  label: requiredText("Combination label", 60),
  appeared: z.number().int().min(0).optional(),
  passed: z.number().int().min(0).optional(),
  distinction: z.number().int().min(0).optional(),
  firstClass: z.number().int().min(0).optional(),
  highestScore: percentage.optional(),
  averageScore: percentage.optional(),
  grades: gradeCountsSchema.optional(),
  boys: cohortSplitSchema.optional(),
  girls: cohortSplitSchema.optional(),
  toppers: z.array(topperSchema).max(RESULT_MAX_TOPPERS).optional(),
});

export const recruiterSchema = z.object({
  name: requiredText("Recruiter name", 120),
  category: z.enum(RECRUITER_CATEGORIES).optional(),
  selected: z.number().int().min(0).optional(),
  averagePackage: z.number().min(0).optional(),
  tieUp: z.boolean().optional(),
  roles: z.array(requiredText("Role", 60)).optional(),
});

export const placementSchema = z.object({
  eligible: z.number().int().min(0).optional(),
  placed: z.number().int().min(0).optional(),
  highestPackage: z.number().min(0).optional(),
  averagePackage: z.number().min(0).optional(),
  recruiters: z.array(recruiterSchema).max(RESULT_MAX_RECRUITERS).optional(),
});

/**
 * No `id` handle: `examCode` is already this row's stable identity (see the
 * model comment on `SelectionSchema`), so the service matches on it directly.
 */
export const selectionSchema = z.object({
  examCode: z.enum(EXAM_CODES),
  appeared: z.number().int().min(0).optional(),
  qualified: z.number().int().min(0).optional(),
  bestRank: z.number().int().min(1).optional(),
  toppers: z.array(topperSchema).max(RESULT_MAX_TOPPERS).optional(),
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
  distinction: z.number().int().min(0).optional(),
  firstClass: z.number().int().min(0).optional(),
  boys: cohortSplitSchema.optional(),
  girls: cohortSplitSchema.optional(),
  combinations: z.array(combinationSchema).max(RESULT_MAX_COMBINATIONS).optional(),
  placement: placementSchema.optional(),
  selections: z.array(selectionSchema).max(RESULT_MAX_SELECTIONS).optional(),
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
  distinction: outcomeFields.distinction,
  firstClass: outcomeFields.firstClass,
  boys: outcomeFields.boys,
  girls: outcomeFields.girls,
  combinations: outcomeFields.combinations,
  placement: outcomeFields.placement,
  selections: outcomeFields.selections,
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
  distinction?: number | null;
  firstClass?: number | null;
  boys?: { appeared?: number | null; passed?: number | null } | null;
  girls?: { appeared?: number | null; passed?: number | null } | null;
  bands?: { label: string; minPercentage: number; maxPercentage: number; count: number }[] | null;
  toppers?: { name: string; percentage?: number; consentAcknowledged?: boolean | null }[] | null;
  combinations?:
    | {
        label: string;
        appeared?: number | null;
        passed?: number | null;
        distinction?: number | null;
        firstClass?: number | null;
        boys?: { appeared?: number | null; passed?: number | null } | null;
        girls?: { appeared?: number | null; passed?: number | null } | null;
        // Specific keys, not `Record<string, ...>` — the Mongoose- and
        // Zod-inferred shapes this is called with (GradeCountsSchema /
        // gradeCountsSchema) have no index signature, so a `Record<string, T>`
        // parameter here would not accept them: TypeScript requires the
        // source type to itself carry an index signature to satisfy one on
        // the target, which a fixed-key object type never does.
        grades?: {
          "90+"?: number | null;
          "80-90"?: number | null;
          "70-80"?: number | null;
          "60-70"?: number | null;
          "50-60"?: number | null;
          below50?: number | null;
        } | null;
      }[]
    | null;
  placement?: {
    eligible?: number | null;
    placed?: number | null;
    highestPackage?: number | null;
    averagePackage?: number | null;
    recruiters?: { name: string; selected?: number | null }[] | null;
  } | null;
  selections?: { examCode: ExamCode; appeared?: number | null; qualified?: number | null }[] | null;
};

/**
 * Cross-field rules, checked against the MERGED record rather than the request
 * body — a PATCH carrying only `bands` has no `appeared` of its own to compare
 * against, so the service merges first and calls this second.
 */
export function assertResultInvariants(input: ResultInvariantInput): void {
  // Checked first, ahead of the passed/appeared comparison below: a request
  // can fail this AND that at once, and the cohort split is the more specific
  // diagnosis a caller should see (Task 3 fix — see task-3-report.md).
  assertCohortSplit(input.boys, input.girls, input.appeared, "");

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

  if ((input.distinction ?? 0) + (input.firstClass ?? 0) > input.passed) {
    throw validationError(
      "distinction and first class together exceed the number who passed",
    );
  }

  const combinations = input.combinations ?? [];

  const combinationLabels = new Set<string>();
  for (const combination of combinations) {
    const trimmed = combination.label.trim();
    if (combinationLabels.has(trimmed)) {
      throw validationError("combinations: each combination needs a distinct label");
    }
    combinationLabels.add(trimmed);

    const cAppeared = combination.appeared ?? 0;
    const cPassed = combination.passed ?? 0;
    // Guarded on `appeared` being given at all: an absent `appeared` is
    // unknown, not zero, so it cannot be the basis for "more passed than
    // appeared" — that would misfire against a row that only reports
    // `passed` (Task 3 fix — see task-3-report.md).
    if (combination.appeared != null && cPassed > cAppeared) {
      throw validationError(
        `combinations: "${combination.label}" has more passed than appeared`,
      );
    }

    if ((combination.distinction ?? 0) + (combination.firstClass ?? 0) > cPassed) {
      throw validationError(
        "distinction and first class together exceed the number who passed",
      );
    }

    assertCohortSplit(combination.boys, combination.girls, cAppeared, "");

    // The explicit `<number>` sidesteps a TS inference quirk: with the
    // fixed-key, all-optional `grades` object type, plain inference leaves
    // `total` typed as possibly null/undefined even though the seed is `0`
    // (Task 3 fix — see task-3-report.md).
    const gradeTotal = Object.values(combination.grades ?? {}).reduce<number>(
      (total, count) => total + (count ?? 0),
      0,
    );
    if (gradeTotal > cAppeared) {
      throw validationError("grades: the grade bands account for more students than appeared");
    }
  }

  const combinationTotal = combinations.reduce((total, c) => total + (c.appeared ?? 0), 0);
  if (combinationTotal > input.appeared) {
    throw validationError("combinations: the combinations account for more students than appeared");
  }

  const placement = input.placement;
  if (placement) {
    const eligible = placement.eligible ?? 0;
    const placed = placement.placed ?? 0;
    // Guarded on `eligible` being given: absent means unknown, not zero, so
    // it cannot be the basis for "more placed than eligible" on its own
    // (Task 3 fix — see task-3-report.md).
    if (placement.eligible != null && placed > eligible) {
      throw validationError("placement: more students placed than were eligible");
    }

    const recruiters = placement.recruiters ?? [];
    const recruiterNames = new Set<string>();
    for (const recruiter of recruiters) {
      const trimmed = recruiter.name.trim();
      if (recruiterNames.has(trimmed)) {
        throw validationError("placement: each recruiter needs a distinct name");
      }
      recruiterNames.add(trimmed);
    }

    const selectedTotal = recruiters.reduce((total, r) => total + (r.selected ?? 0), 0);
    if (selectedTotal > placed) {
      throw validationError(
        "placement: the named recruiters account for more selections than the placed total",
      );
    }

    const highest = placement.highestPackage ?? 0;
    const average = placement.averagePackage ?? 0;
    if (average > highest && highest > 0) {
      throw validationError("placement: the average package cannot exceed the highest");
    }
  }

  const selections = input.selections ?? [];

  // Duplicate exams are checked across the whole list before any per-row
  // appeared/qualified check runs, so one row's own violation never hides a
  // duplicate reported by a row after it (Task 3 fix — see task-3-report.md).
  const seenExams = new Set<ExamCode>();
  for (const selection of selections) {
    if (seenExams.has(selection.examCode)) {
      throw validationError("selections: each exam can appear only once");
    }
    seenExams.add(selection.examCode);
  }

  for (const selection of selections) {
    const sQualified = selection.qualified ?? 0;
    // Guarded on `appeared` being given: absent means unknown, not zero — a
    // selection can report `qualified` alone, from a cohort distinct from
    // this result's own `passed`, with nothing to compare it against.
    if (selection.appeared != null && sQualified > selection.appeared) {
      throw validationError(`selections: ${selection.examCode} has more qualified than appeared`);
    }
  }
}

/**
 * Shared by the result itself and every combination: boys and girls together
 * cannot exceed the cohort they are a split OF, and neither half can pass more
 * than it took in. The empty `context` parameter is reserved for a future
 * per-combination label in the message; today's tests accept either wording.
 */
function assertCohortSplit(
  boys: { appeared?: number | null; passed?: number | null } | null | undefined,
  girls: { appeared?: number | null; passed?: number | null } | null | undefined,
  appeared: number,
  context: string,
): void {
  // Each half's own consistency is checked before their sum: a row whose
  // `boys.passed` already exceeds its own `boys.appeared` should be told
  // that specifically, not folded into the aggregate "together exceed"
  // message (Task 3 fix — see task-3-report.md).
  if (boys && (boys.passed ?? 0) > (boys.appeared ?? 0)) {
    throw validationError(`${context}boys: more passed than appeared`);
  }
  if (girls && (girls.passed ?? 0) > (girls.appeared ?? 0)) {
    throw validationError(`${context}girls: more passed than appeared`);
  }

  const boysAppeared = boys?.appeared ?? 0;
  const girlsAppeared = girls?.appeared ?? 0;
  if (boysAppeared + girlsAppeared > appeared) {
    throw validationError(`${context}boys and girls together exceed the number who appeared`);
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
