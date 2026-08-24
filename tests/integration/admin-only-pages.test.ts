import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";

async function signIn(role: "COUNSELOR" | "FRONT_DESK", email: string) {
  const user = await makeUser("INS0001", role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId: "INS0001",
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
}

beforeAll(() => startTestDatabase("admin-only-pages"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("pages that must stay Admin-only now that other roles exist", () => {
  it("a Counselor loading /profile is redirected to /dashboard", async () => {
    await signIn("COUNSELOR", "c@infinityschool.edu.in");
    const { default: ProfilePage } = await import("@/app/(dashboard)/profile/page");

    await expect(ProfilePage()).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
  });

  it("a Front Desk user loading /integration is redirected to /dashboard", async () => {
    await signIn("FRONT_DESK", "fd@infinityschool.edu.in");
    const { default: IntegrationPage } = await import("@/app/(dashboard)/integration/page");

    await expect(
      IntegrationPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) }),
    ).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
  });

  it("a Counselor loading /results is redirected to /dashboard", async () => {
    await signIn("COUNSELOR", "c@infinityschool.edu.in");
    const { default: ResultsPage } = await import("@/app/(dashboard)/results/page");

    await expect(ResultsPage()).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
  });

  it("a Counselor loading /fees is redirected to /dashboard", async () => {
    await signIn("COUNSELOR", "c@infinityschool.edu.in");
    const { default: FeesPage } = await import("@/app/(dashboard)/fees/page");

    await expect(FeesPage()).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
  });
});
