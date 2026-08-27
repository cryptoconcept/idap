import { z } from "zod";
import {
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_LEVELS,
  ACHIEVEMENT_MAX_STUDENTS,
  ALUMNI_CATEGORIES,
  SHOWCASE_STATUSES,
} from "@/lib/constants";
import { optionalDateSchema, optionalText, requiredText } from "./common";

const achievementStudentSchema = z.object({
  name: requiredText("Student name", 100),
  grade: optionalText(20),
});

/**
 * `photos`/`certificates` are deliberately absent, same reasoning as
 * `topperSchema.photoUrl` in `validation/result.ts`: those storage keys are
 * written only by the upload endpoints (Task 7's `addPhoto`/`addCertificate`),
 * so accepting them here would let a caller point a record at another
 * tenant's blob. `status` is likewise absent — a new record always starts
 * `ACTIVE` at the model layer; only a patch can hide one.
 */
export const achievementCreateSchema = z.object({
  category: z.enum(ACHIEVEMENT_CATEGORIES),
  title: requiredText("Achievement title", 120),
  description: optionalText(2000),
  eventDate: optionalDateSchema,
  level: z.enum(ACHIEVEMENT_LEVELS).optional(),
  students: z.array(achievementStudentSchema).max(ACHIEVEMENT_MAX_STUDENTS).optional(),
});
export type AchievementCreateInput = z.infer<typeof achievementCreateSchema>;

/**
 * Every field optional for a partial update. `description` is the one
 * free-text field on this schema an admin can legitimately want to clear (a
 * note written in error, or one that's no longer accurate), so it takes the
 * same three-state shape as `mediaItemPatchSchema.caption`
 * (`src/lib/validation/institution.ts:191`): absent (`undefined`) leaves the
 * stored value alone, a string `$set`s it, and explicit `null` is the
 * documented way to clear it. `optionalText` alone would collapse an admin's
 * "clear it" `""` into `undefined` — indistinguishable from "don't touch
 * it" — which is the exact bug this project already shipped once, for media
 * captions.
 *
 * `category` and `title` stay non-nullable: a patch may change either but
 * never clear one to "no category"/"no title" — there is no such state, the
 * same reason `updateScholarshipSchema`'s `name` isn't nullable either.
 * `eventDate`, `level` and `students` are also not nullable: an achievement
 * with no date, the default level, or no roster is an ordinary valid state
 * reached by simply never setting the field, and `students` can already be
 * cleared unambiguously with an empty array — no three-state trick needed.
 * `status` is the dashboard hide/show toggle, always one of
 * `SHOWCASE_STATUSES`; there is no "unset" status to clear it to.
 */
export const achievementPatchSchema = z.object({
  category: z.enum(ACHIEVEMENT_CATEGORIES).optional(),
  title: requiredText("Achievement title", 120).optional(),
  description: optionalText(2000).nullable(),
  eventDate: optionalDateSchema,
  level: z.enum(ACHIEVEMENT_LEVELS).optional(),
  students: z.array(achievementStudentSchema).max(ACHIEVEMENT_MAX_STUDENTS).optional(),
  status: z.enum(SHOWCASE_STATUSES).optional(),
});
export type AchievementPatchInput = z.infer<typeof achievementPatchSchema>;

/**
 * `photo` is deliberately absent — same reasoning as `achievementCreateSchema`
 * above: it's a storage key written only by the upload endpoint (Task 7's
 * `setPhoto`). `status` is likewise absent; a new record always starts
 * `ACTIVE`.
 */
export const alumnusCreateSchema = z.object({
  name: requiredText("Alumnus name", 100),
  batch: optionalText(20),
  category: z.enum(ALUMNI_CATEGORIES),
  currentRole: optionalText(120),
  org: optionalText(120),
  note: optionalText(500),
});
export type AlumnusCreateInput = z.infer<typeof alumnusCreateSchema>;

/**
 * Same three-state convention as `achievementPatchSchema.description` above,
 * applied to every optional free-text field here: `batch`, `currentRole`,
 * `org` and `note` are all things an admin can legitimately blank out — a
 * cohort mis-entered, a role no longer current, an organisation typed by
 * mistake, a note that's gone stale — so all four are `.nullable()`. `name`
 * and `category` stay non-nullable: every alumnus has one of each, patch or
 * not, the same reasoning as `achievementPatchSchema.title`/`category`.
 * `status` is the hide/show toggle, not a value to clear.
 */
export const alumnusPatchSchema = z.object({
  name: requiredText("Alumnus name", 100).optional(),
  batch: optionalText(20).nullable(),
  category: z.enum(ALUMNI_CATEGORIES).optional(),
  currentRole: optionalText(120).nullable(),
  org: optionalText(120).nullable(),
  note: optionalText(500).nullable(),
  status: z.enum(SHOWCASE_STATUSES).optional(),
});
export type AlumnusPatchInput = z.infer<typeof alumnusPatchSchema>;
