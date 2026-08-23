import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution } from "@/models";
import { AppError } from "@/lib/api/errors";

/** Words that would collide with a route or read as a system page. */
export const RESERVED_SLUGS = [
  "api",
  "admin",
  "public",
  "login",
  "logout",
  "institution",
  "institutions",
  "settings",
  "apply",
  "widget",
  "dashboard",
  "profile",
  "media",
] as const;

const MAX_ATTEMPTS = 50;

// Built from a string literal so the source stays free of literal combining
// diacritic codepoints (matches the CONTROL_CHARS convention in
// src/lib/validation/common.ts).
const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/g, "");
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: number }).code === 11000,
  );
}

/**
 * Writes a slug onto an institution, resolving collisions by suffix.
 *
 * The unique index is the lock. Reading first to check availability would hand
 * the same slug to two concurrent callers, so the write itself is the test:
 * attempt, catch 11000, try the next candidate.
 *
 * Idempotent per institution — an institution that already has a slug keeps it,
 * because consumers hold URLs pointing at it.
 */
export async function claimSlug(institutionId: string, base: string): Promise<string> {
  await connectToDatabase();

  const existing = await Institution.findOne({ institutionId }).select("slug").lean();
  if (!existing) throw new AppError("NOT_FOUND", "Institution not found");
  if (existing.slug) return existing.slug;

  let candidate = slugify(base);
  if (!candidate || candidate.length < 4) candidate = `institution-${institutionId.toLowerCase()}`;
  if ((RESERVED_SLUGS as readonly string[]).includes(candidate)) candidate = `${candidate}-2`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const value = attempt === 1 ? candidate : `${candidate}-${attempt}`;
    try {
      const updated = await Institution.findOneAndUpdate(
        { institutionId, slug: { $exists: false } },
        { $set: { slug: value } },
        { new: true },
      ).lean();
      if (updated?.slug) return updated.slug;
      // Lost a race to another writer on the same institution — take theirs.
      const now = await Institution.findOne({ institutionId }).select("slug").lean();
      if (now?.slug) return now.slug;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  throw new AppError("CONFLICT", "Could not allocate a unique slug");
}

/** Convenience wrapper used at creation time. */
export async function allocateSlug(input: {
  institutionId: string;
  institutionName: string;
  locality?: string;
}): Promise<string> {
  const base = [input.institutionName, input.locality].filter(Boolean).join(" ");
  return claimSlug(input.institutionId, base);
}
