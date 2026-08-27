import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { GET as getById } from "@/app/api/public/[institutionId]/profile/route";
import { GET as getBySlug } from "@/app/api/public/institutions/[slug]/route";
import { PUBLIC_READ_RATE_LIMIT } from "@/lib/constants";

/** Recursively asserts none of the forbidden keys appear anywhere in the payload. */
function assertNoForbiddenKeys(value: unknown, forbidden: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item, forbidden);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      expect(forbidden).not.toContain(key);
      assertNoForbiddenKeys(nested, forbidden);
    }
  }
}

/** `ip` lands in the header the rate limiter buckets on; omitted, every caller
 * shares the "unknown" bucket, which is fine for the non-limiter tests. */
function requestFor(url: string, ip?: string) {
  return new Request(url, { headers: ip ? { "x-forwarded-for": ip } : undefined });
}

async function callById(institutionId: string, ip?: string) {
  return getById(requestFor(`http://localhost/api/public/${institutionId}/profile`, ip), {
    params: Promise.resolve({ institutionId }),
  } as never);
}

async function callBySlug(slug: string, ip?: string) {
  return getBySlug(requestFor(`http://localhost/api/public/institutions/${slug}`, ip), {
    params: Promise.resolve({ slug }),
  } as never);
}

describe("public profile API", () => {
  beforeAll(async () => {
    await startTestDatabase("publicprofile");
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  it("returns 200 for a published institution looked up by id", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      facilities: [{ code: "LIBRARY", label: "Library", available: true }],
    });

    const response = await callById("INS0001");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile.institutionName).toBe("INS0001 Institute");
    expect(body.profile.slug).toBe("sunrise-academy");
    expect(body.profile.facilities).toEqual([
      { code: "LIBRARY", label: "Library", available: true },
    ]);
  });

  it("returns the identical institution when looked up by slug, normalising case", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
    });

    // Mixed-case slug in the URL still resolves — the route lowercases before lookup.
    const response = await callBySlug("Sunrise-Academy");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile.institutionId).toBe("INS0001");
  });

  it("returns 404 for a draft institution, by id and by slug", async () => {
    await makeInstitution("INS0001", {
      slug: "draft-school",
      profileStatus: "DRAFT",
    });

    const byId = await callById("INS0001");
    expect(byId.status).toBe(404);

    const bySlug = await callBySlug("draft-school");
    expect(bySlug.status).toBe(404);
  });

  it("returns 404 for a deactivated institution even though it is published", async () => {
    await makeInstitution("INS0001", {
      slug: "deactivated-school",
      profileStatus: "PUBLISHED",
      active: false,
    });

    const byId = await callById("INS0001");
    expect(byId.status).toBe(404);

    const bySlug = await callBySlug("deactivated-school");
    expect(bySlug.status).toBe(404);
  });

  it("returns 404 for an unknown id or slug, never 403", async () => {
    const byId = await callById("INS9999");
    expect(byId.status).toBe(404);

    const bySlug = await callBySlug("no-such-school");
    expect(bySlug.status).toBe(404);
  });

  it("never leaks active, profileStatus, or publishedAt in the response body", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
    });

    const response = await callById("INS0001");
    const body = await response.json();
    assertNoForbiddenKeys(body, ["active", "profileStatus", "publishedAt"]);
  });

  it("blocks a burst of reads from one IP once the limit is spent", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
    });

    const attacker = "203.0.113.7";
    for (let index = 0; index < PUBLIC_READ_RATE_LIMIT.limit; index += 1) {
      expect((await callById("INS0001", attacker)).status).toBe(200);
    }

    const blocked = await callById("INS0001", attacker);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    // A shared cache must not hold on to one visitor's 429.
    expect(blocked.headers.get("Cache-Control")).toBe("no-store");

    // The bucket is per IP, not per institution: inventing a different id or
    // reaching for the slug route buys no fresh allowance, which is the whole
    // point on an endpoint whose 200s are cacheable.
    expect((await callById("INS0002", attacker)).status).toBe(429);
    expect((await callBySlug("sunrise-academy", attacker)).status).toBe(429);

    // Another visitor is untouched.
    expect((await callById("INS0001", "198.51.100.4")).status).toBe(200);
  });

  it("omits hidden media items from the payload", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      media: [
        { kind: "IMAGE", url: "https://cdn.test/visible.jpg", status: "ACTIVE" },
        { kind: "IMAGE", url: "https://cdn.test/hidden.jpg", status: "HIDDEN" },
      ],
    });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.media).toHaveLength(1);
    expect(body.profile.media[0].url).toBe("https://cdn.test/visible.jpg");
    expect(body.profile.media[0].kind).toBe("IMAGE");
    expect(typeof body.profile.media[0].id).toBe("string");
    expect(body.profile.media[0].id.length).toBeGreaterThan(0);
  });

  // Mutation check (see task-7-report.md): deleting the `status !== "HIDDEN"`
  // filter in public-projection.ts makes exactly this test fail — the hidden
  // item's id reappears in the response body.
  it("MUTATION-DISTINGUISHING: hidden media never leaves the building", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      media: [
        { kind: "IMAGE", url: "https://cdn.test/visible.jpg", status: "ACTIVE" },
        { kind: "IMAGE", url: "https://cdn.test/hidden.jpg", status: "HIDDEN" },
      ],
    });

    const response = await callById("INS0001");
    const body = await response.json();
    const urls = (body.profile.media as { url: string }[]).map((item) => item.url);
    expect(urls).not.toContain("https://cdn.test/hidden.jpg");
  });

  it("resolves a relative stored media key to an absolute URL", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      media: [
        { kind: "BROCHURE", url: "/api/media/INS0001/brochure.pdf", status: "ACTIVE" },
      ],
    });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.media[0].url).toBe(
      "https://admissions.test/api/media/INS0001/brochure.pdf",
    );
  });

  it("returns media: [] for a published institution with no media", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
    });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.media).toEqual([]);
  });

  it("sorts media by sortOrder, then uploadedAt to break ties, and exposes provider/videoId", async () => {
    await makeInstitution("INS0001", {
      slug: "sunrise-academy",
      profileStatus: "PUBLISHED",
      media: [
        {
          kind: "IMAGE",
          url: "https://cdn.test/second.jpg",
          status: "ACTIVE",
          sortOrder: 1,
          uploadedAt: new Date("2026-01-02"),
        },
        {
          kind: "VIDEO",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          provider: "YOUTUBE",
          videoId: "dQw4w9WgXcQ",
          status: "ACTIVE",
          sortOrder: 1,
          uploadedAt: new Date("2026-01-01"),
        },
      ],
    });

    const response = await callById("INS0001");
    const body = await response.json();
    expect(body.profile.media).toHaveLength(2);
    expect(body.profile.media[0].kind).toBe("VIDEO");
    expect(body.profile.media[0].provider).toBe("YOUTUBE");
    expect(body.profile.media[0].videoId).toBe("dQw4w9WgXcQ");
    expect(body.profile.media[1].kind).toBe("IMAGE");
  });
});
