import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution } from "@/models";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";
import { forbidden, unauthorized } from "@/lib/api/errors";

export type TenantInstitution = {
  institutionId: string;
  institutionName: string;
  institutionType: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  website?: string;
  logoUrl?: string;
  active: boolean;
};

/**
 * Message shown wherever the platform admin is turned away from tenant data.
 * Kept in one place so the boundary reads the same everywhere it is enforced.
 */
export const PLATFORM_ADMIN_DENIED =
  "Platform administrators cannot access institution data. Enquiries and applications belong to the institution that received them.";

export function serializeInstitution(doc: {
  institutionId: string;
  institutionName: string;
  institutionType: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  active?: boolean | null;
}): TenantInstitution {
  return {
    institutionId: doc.institutionId,
    institutionName: doc.institutionName,
    institutionType: doc.institutionType,
    address: doc.address ?? undefined,
    city: doc.city ?? undefined,
    state: doc.state ?? undefined,
    pincode: doc.pincode ?? undefined,
    contactPerson: doc.contactPerson ?? undefined,
    phone: doc.phone ?? undefined,
    email: doc.email ?? undefined,
    website: doc.website ?? undefined,
    logoUrl: doc.logoUrl ?? undefined,
    active: doc.active ?? true,
  };
}

/**
 * The single source of truth for "which tenant is this request acting on".
 * The institution is always derived from the authenticated session — a client
 * supplied institutionId is never trusted.
 */
export const getCurrentInstitution = cache(async (): Promise<TenantInstitution | null> => {
  const user = await getCurrentUser();
  if (!user?.institutionId) return null;

  await connectToDatabase();
  const institution = await Institution.findOne({ institutionId: user.institutionId }).lean();
  if (!institution) return null;
  return serializeInstitution(institution);
});

/** Throws (API surface) when no valid session is present. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  return user;
}

export async function requireSuperAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") throw forbidden();
  return user;
}

/** Throws unless the caller is an institution admin with a live institution. */
export async function requireInstitution(): Promise<{
  user: CurrentUser;
  institution: TenantInstitution;
}> {
  const user = await requireUser();
  if (user.role !== "INSTITUTION_ADMIN" || !user.institutionId) {
    throw forbidden(user.role === "SUPER_ADMIN" ? PLATFORM_ADMIN_DENIED : undefined);
  }
  const institution = await getCurrentInstitution();
  if (!institution) throw forbidden("Institution not found");
  if (!institution.active) {
    throw forbidden("This institution account is currently inactive");
  }
  return { user, institution };
}

/**
 * Builds the `institutionId` clause for any query that touches tenant data —
 * enquiries, applications, notes, activity, documents.
 *
 * The platform administrator provisions institutions; they are deliberately not
 * a super-user over what those institutions receive. There is no code path that
 * returns an unscoped clause, so no amount of parameter tampering can widen a
 * query beyond one tenant.
 */
export function tenantFilter(user: CurrentUser): { institutionId: string } {
  if (user.role === "SUPER_ADMIN") throw forbidden(PLATFORM_ADMIN_DENIED);
  if (!user.institutionId) throw forbidden();
  return { institutionId: user.institutionId };
}

/** API guard for every route that reads or writes tenant data. */
export async function requireTenantUser(): Promise<{
  user: CurrentUser;
  clause: { institutionId: string };
}> {
  const user = await requireUser();
  return { user, clause: tenantFilter(user) };
}

/** Page-level guard: redirects instead of throwing. */
export async function requireUserPage(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Page-level guard for tenant screens. Platform admins are sent back to their
 * own area rather than shown an error, because this is a role boundary rather
 * than a failure.
 */
export async function requireTenantUserPage(): Promise<CurrentUser> {
  const user = await requireUserPage();
  if (user.role === "SUPER_ADMIN") redirect("/admin");
  if (!user.institutionId) redirect("/login");
  return user;
}

/**
 * Scope for API *credential metadata* only — never for enquiry or application
 * data.
 *
 * A platform administrator may list and revoke credentials across institutions
 * so that a leaked key can be shut off quickly. That is safe because credential
 * metadata contains no applicant information and the secret itself is never
 * readable: only its HMAC is stored. Issuing new credentials is deliberately
 * *not* a platform-admin power, since a key with READ_APPLICATION would be a
 * way around the tenant-data boundary above.
 */
export function credentialScope(
  user: CurrentUser,
  requestedInstitutionId?: string | null,
): Record<string, unknown> {
  if (user.role === "SUPER_ADMIN") {
    return requestedInstitutionId ? { institutionId: requestedInstitutionId } : {};
  }
  if (!user.institutionId) throw forbidden();
  return { institutionId: user.institutionId };
}
