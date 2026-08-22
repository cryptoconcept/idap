import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "aem_session";

/** Routes that require an authenticated dashboard session. */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/enquiries",
  "/applications",
  "/integration",
  "/settings",
  "/admin",
];

/**
 * Screens that read institution data. A platform administrator provisions
 * institutions and is deliberately not a super-user over what they receive, so
 * they are turned away here — before anything renders — as well as by the
 * server-side guards in `lib/tenant`, which remain the authoritative check.
 */
const TENANT_PREFIXES = ["/dashboard", "/enquiries", "/applications", "/integration", "/settings"];

const ADMIN_PREFIX = "/admin";

type Session = { role?: string };

function matches(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Verifies the session signature and reads the role claim. This does not hit
 * the database — pages and route handlers re-verify against the user record
 * before reading any data.
 */
async function readSession(request: NextRequest): Promise<Session | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: "aem-platform",
      audience: "aem-dashboard",
      algorithms: ["HS256"],
    });
    return { role: typeof payload.role === "string" ? payload.role : undefined };
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const session = await readSession(request);

  if (matches(pathname, PROTECTED_PREFIXES)) {
    if (!session) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(loginUrl);
    }

    // Each role is redirected to its own area rather than shown an error: this
    // is a boundary between roles, not a failure.
    if (session.role === "SUPER_ADMIN" && matches(pathname, TENANT_PREFIXES)) {
      return NextResponse.redirect(new URL("/admin", request.url));
    }
    if (session.role !== "SUPER_ADMIN" && matches(pathname, [ADMIN_PREFIX])) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    return NextResponse.next();
  }

  if (pathname === "/login" && session) {
    return NextResponse.redirect(
      new URL(session.role === "SUPER_ADMIN" ? "/admin" : "/dashboard", request.url),
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/enquiries/:path*",
    "/applications/:path*",
    "/integration/:path*",
    "/settings/:path*",
    "/admin/:path*",
    "/login",
  ],
};
