import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeProfiledInstitution } from "../helpers/factories";
import { GET as getByInstitutionId } from "@/app/api/public/[institutionId]/scholarships/route";
import { GET as getBySlug } from "@/app/api/public/institutions/[slug]/scholarships/route";
import { Scholarship } from "@/models";
import { ScholarshipService } from "@/services/scholarship.service";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

function input(overrides: { name?: string } = {}) {
  return {
    name: "Merit Scholarship",
    criteria: "Top 10% of the class",
    amount: "₹50,000",
    ...overrides,
  };
}

beforeAll(async () => {
  await startTestDatabase("scholarship-public");
  await Scholarship.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("GET /api/public/:institutionId/scholarships", () => {
  it("returns a published scholarship by institutionId", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await ScholarshipService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/scholarships"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.scholarships).toHaveLength(1);
    expect(payload.scholarships[0].name).toBe("Merit Scholarship");
  });

  it("returns a published scholarship by slug", async () => {
    await makeProfiledInstitution("INS0001", {
      profileStatus: "PUBLISHED",
      slug: "infinity-school",
    });
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await ScholarshipService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getBySlug(
      new Request("http://localhost/api/public/institutions/infinity-school/scholarships"),
      { params: Promise.resolve({ slug: "infinity-school" }) } as never,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.scholarships).toHaveLength(1);
    expect(payload.scholarships[0].name).toBe("Merit Scholarship");
  });

  it("excludes a DRAFT scholarship", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    await ScholarshipService.create("INS0001", input(), actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/scholarships"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).scholarships).toEqual([]);
  });

  it("404s for an institution whose profileStatus is DRAFT", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "DRAFT" });
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await ScholarshipService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/scholarships"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("404s for an inactive institution", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED", active: false });
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await ScholarshipService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/scholarships"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("404s for a nonexistent institution", async () => {
    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS9999/scholarships"),
      { params: Promise.resolve({ institutionId: "INS9999" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("carries no institutionId, status, or _id on any row", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const created = await ScholarshipService.create("INS0001", input(), actor);
    await ScholarshipService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/scholarships"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    const payload = await response.json();
    expect(payload.scholarships).toHaveLength(1);
    const row = payload.scholarships[0];
    expect(row.institutionId).toBeUndefined();
    expect(row.status).toBeUndefined();
    expect(row._id).toBeUndefined();
  });
});
