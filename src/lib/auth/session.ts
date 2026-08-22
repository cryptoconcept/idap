import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";
import type { UserRole } from "@/lib/constants";

export const SESSION_COOKIE = "aem_session";

export type SessionPayload = {
  sub: string;
  role: UserRole;
  institutionId?: string;
  name: string;
  email: string;
  v: number;
};

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.AUTH_SECRET);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer("aem-platform")
    .setAudience("aem-dashboard")
    .setExpirationTime(`${env.SESSION_TTL_HOURS}h`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: "aem-platform",
      audience: "aem-dashboard",
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.role !== "string") return null;
    return {
      sub: payload.sub,
      role: payload.role as UserRole,
      institutionId: typeof payload.institutionId === "string" ? payload.institutionId : undefined,
      name: String(payload.name ?? ""),
      email: String(payload.email ?? ""),
      v: Number(payload.v ?? 0),
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: env.SESSION_TTL_HOURS * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
