import { z } from "zod";

// Built from a string literal so the source stays free of literal control bytes.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

/** Strips control characters and collapses whitespace on every string we persist. */
export const cleanString = (value: string) =>
  value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();

export const requiredText = (label: string, max = 200) =>
  z
    .string({ error: `${label} is required` })
    .transform(cleanString)
    .refine((value) => value.length > 0, { message: `${label} is required` })
    .refine((value) => value.length <= max, {
      message: `${label} must be ${max} characters or fewer`,
    });

export const optionalText = (max = 200) =>
  z
    .string()
    .transform(cleanString)
    .refine((value) => value.length <= max, { message: `Must be ${max} characters or fewer` })
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional();

/** Tolerant of +91 / spacing; normalises to the bare national number. */
export const phoneSchema = z
  .string({ error: "Phone number is required" })
  .transform((value) => value.replace(/[\s\-()]/g, ""))
  .refine((value) => /^(\+?91)?[0-9]{10}$/.test(value) || /^[0-9]{7,15}$/.test(value), {
    message: "Enter a valid phone number",
  })
  .transform((value) => value.replace(/^\+?91(?=\d{10}$)/, ""));

export const optionalPhoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s\-()]/g, ""))
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional()
  .refine(
    (value) =>
      value === undefined ||
      /^(\+?91)?[0-9]{10}$/.test(value) ||
      /^[0-9]{7,15}$/.test(value),
    { message: "Enter a valid phone number" },
  );

/**
 * Trims and lowercases *before* validating. Doing it the other way round — the
 * shape `z.email().transform(trim)` — rejects an address that a user typed with
 * a trailing space, which is a common way to paste one.
 */
export const emailSchema = z
  .string({ error: "Email is required" })
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email("Enter a valid email address"));

export const optionalEmailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional()
  .refine((value) => value === undefined || z.email().safeParse(value).success, {
    message: "Enter a valid email address",
  });

export const optionalUrlSchema = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional()
  .refine((value) => value === undefined || /^https?:\/\/[^\s]+$/i.test(value), {
    message: "Enter a valid URL starting with http:// or https://",
  });

export const optionalPincodeSchema = z
  .string()
  .transform((value) => value.replace(/\s/g, ""))
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional()
  .refine((value) => value === undefined || /^[0-9]{4,10}$/.test(value), {
    message: "Enter a valid pincode",
  });

/** Accepts `YYYY-MM-DD` or an ISO datetime and normalises to a Date. */
export const optionalDateSchema = z
  .union([z.string(), z.date()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value instanceof Date) return value;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  });

export const academicYearSchema = z
  .string({ error: "Academic year is required" })
  .transform((value) => value.trim())
  .refine((value) => /^\d{4}\s?-\s?\d{2}(\d{2})?$/.test(value), {
    message: "Academic year must look like 2026-27",
  })
  .transform((value) => value.replace(/\s/g, ""));

/**
 * A 24-character hex object id, as a string. Shape only — whether the id
 * refers to anything is a service concern, and a malformed one is turned into
 * NOT_FOUND there rather than a 500.
 */
export const objectIdString = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");
