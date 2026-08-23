import { Institution, User, ApiClient } from "@/models";
import { hashPassword } from "@/lib/security/password";
import { generateKeyId, generateSecret, hashSecret } from "@/lib/security/tokens";
import type { ApiPermission } from "@/lib/constants";
import type { CurrentUser } from "@/lib/auth/current-user";

export async function makeInstitution(
  institutionId: string,
  overrides: Record<string, unknown> = {},
) {
  return Institution.create({
    institutionId,
    institutionName: `${institutionId} Institute`,
    institutionType: "SCHOOL",
    city: "Mysore",
    state: "Karnataka",
    active: true,
    ...overrides,
  });
}

/**
 * Like `makeInstitution`, but with a full profile filled in — slug, academic,
 * management, and a couple of facilities — for tests exercising the profile
 * surface (completion scoring, the public projection, section updates)
 * rather than bare tenant-isolation checks. `makeInstitution` itself is left
 * untouched; existing tests depend on its exact shape.
 */
export async function makeProfiledInstitution(
  institutionId: string,
  overrides: Record<string, unknown> = {},
) {
  return Institution.create({
    institutionId,
    institutionName: `${institutionId} Institute`,
    institutionType: "SCHOOL",
    city: "Mysore",
    state: "Karnataka",
    active: true,
    slug: `${institutionId.toLowerCase()}-institute`,
    tagline: "Learning that lasts",
    description: "A CBSE school in Mysore teaching Grade 1 through Grade 10.",
    establishedYear: 2005,
    profileStatus: "DRAFT",
    academic: {
      board: "CBSE",
      genderType: "CO_ED",
      classesOffered: ["Grade 1", "Grade 10"],
    },
    management: {
      managementType: "TRUST",
      principalName: "Dr. Test Principal",
      headDesignation: "Principal",
    },
    facilities: [
      { code: "LIBRARY", label: "Library", available: true },
      { code: "SCIENCE_LAB", label: "Science Lab", available: true },
    ],
    ...overrides,
  });
}

export async function makeUser(
  institutionId: string | undefined,
  role: "SUPER_ADMIN" | "INSTITUTION_ADMIN" = "INSTITUTION_ADMIN",
  email = `${role.toLowerCase()}-${institutionId ?? "platform"}@example.test`,
) {
  return User.create({
    institutionId,
    name: `${role} ${institutionId ?? ""}`.trim(),
    email,
    passwordHash: await hashPassword("Password!2026"),
    role,
    active: true,
  });
}

/** A plain session object, matching what `getCurrentUser` resolves to. */
export function sessionFor(
  role: "SUPER_ADMIN" | "INSTITUTION_ADMIN",
  institutionId?: string,
): CurrentUser {
  return {
    id: "6a8880f3446c577c470cd06c",
    name: role === "SUPER_ADMIN" ? "Platform Admin" : "Institution Admin",
    email: "user@example.test",
    role,
    institutionId,
  };
}

export async function makeApiClient(
  institutionId: string,
  permissions: ApiPermission[] = ["CREATE_LEAD", "CREATE_APPLICATION", "READ_APPLICATION"],
  overrides: Record<string, unknown> = {},
) {
  const keyId = generateKeyId();
  const secret = generateSecret();
  const client = await ApiClient.create({
    institutionId,
    name: "Test key",
    keyId,
    secretHash: hashSecret(secret),
    active: true,
    permissions,
    ...overrides,
  });
  return { client, keyId, secret, bearer: `${keyId}.${secret}` };
}

/** Builds the NextRequest-shaped object `authenticateApiClient` reads from. */
export function requestWithBearer(token: string) {
  return {
    headers: new Headers({ authorization: `Bearer ${token}` }),
  } as unknown as import("next/server").NextRequest;
}

export function requestWithKeyHeaders(keyId: string, secret: string) {
  return {
    headers: new Headers({ "x-api-key": keyId, "x-api-secret": secret }),
  } as unknown as import("next/server").NextRequest;
}
