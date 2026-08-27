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
 *
 * The rule for every other field on this schema is not "is it free text" —
 * it's whether an admin can legitimately want the field to hold no value
 * *after having once given it one*. `eventDate` passes that test the same
 * way `description` does: an admin can enter an approximate event date and
 * later learn the school doesn't actually know it (wrong is worse than
 * absent, especially for a field this record sorts and displays by). A
 * `Date` has the exact same three states — absent, present, explicitly
 * cleared — as a string; `optionalText` collapsing `""` to `undefined` was
 * just the shape this bug took in the media phase, not the boundary of it.
 * So `eventDate` is `.nullable()` here, same convention as `description`.
 *
 * `level` does NOT get this treatment, even though it is also an enum that
 * can be miscategorised: the model gives it `default: "SCHOOL"`, so every
 * achievement always has a level. With a default there is no "no level"
 * state to clear back to — a cleared `level` would read as `undefined` on
 * one document while every other document has a value, an inconsistency
 * every consumer would then have to handle. So `level` stays `.optional()`
 * only: a patch may change it, but cannot clear it.
 *
 * `students` fails the test and stays non-nullable: `[]` already means
 * "none" unambiguously, so there is no third state to recover. `status` is
 * the dashboard hide/show toggle, always one of `SHOWCASE_STATUSES`; there
 * is no "unset" status to clear it to.
 */
export const achievementPatchSchema = z.object({
  category: z.enum(ACHIEVEMENT_CATEGORIES).optional(),
  title: requiredText("Achievement title", 120).optional(),
  description: optionalText(2000).nullable(),
  eventDate: optionalDateSchema.nullable(),
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
