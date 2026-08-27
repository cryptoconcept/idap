import { z } from "zod";
import { PLATFORMS } from "@/lib/constants";

const baseUrlSchema = z
  .string({ error: "Base URL is required" })
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: "Base URL is required" })
  .refine((value) => /^https?:\/\/[^\s]+$/i.test(value), {
    message: "Enter a valid URL starting with http:// or https://",
  });

/**
 * `key` is deliberately optional: an admin editing only the base URL or the
 * active flag must not have to re-enter the secret. When it is omitted, the
 * service preserves the stored ciphertext untouched — see
 * `PlatformCredentialService.upsert`.
 */
export const upsertPlatformCredentialSchema = z.object({
  platform: z.enum(PLATFORMS),
  baseUrl: baseUrlSchema,
  active: z.boolean().optional(),
  key: z.string().trim().min(1, "Key cannot be blank").max(500, "Key is too long").optional(),
});
export type UpsertPlatformCredentialInput = z.infer<typeof upsertPlatformCredentialSchema>;
