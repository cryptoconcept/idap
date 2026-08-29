import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeProfiledInstitution } from "../helpers/factories";
import { Vacancy } from "@/models";
import { InstitutionService } from "@/services/institution.service";
import { VacancyService } from "@/services/vacancy.service";
import { DIRECTORY_MAX_PAGE_SIZE } from "@/lib/constants";

beforeAll(async () => {
  await startTestDatabase("public-directory-and-vacancies");
});
afterAll(stopTestDatabase);
afterEach(async () => {
  await clearDatabase();
});

/** A vacancy with the whole eduFleet `listing` sub-document populated. */
async function makeVacancy(institutionId: string, overrides: Record<string, unknown> = {}) {
  return Vacancy.create({
    institutionId,
    title: "Mathematics Teacher",
    subject: "Mathematics",
    description: "Teaching Grades 8 to 10.",
    salaryMin: 30000,
    salaryMax: 45000,
    experienceRequired: 3,
    facilities: ["Provident Fund (PF)", "Gratuity"],
    status: "OPEN",
    ...overrides,
  });
}

const LISTING = {
  jobId: "ef-job-1",
  externalJobId: "vac-1",
  contract: "AGGREGATED",
  lastPushedAt: new Date(),
  claimState: "claimed",
  blockedReason: "eduFleet rejected the district",
  remoteStatus: "active",
};

describe("public vacancies", () => {
  it("MUTATION-DISTINGUISHING: never leaks the eduFleet listing sub-document", async () => {
    // The single most important assertion in this file. `listing` holds which
    // schools syndicate to eduFleet, whether an advert was claimed there, and
    // the text of integration failures. The allow-list projection is the only
    // thing keeping it off a public careers page.
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    await makeVacancy("INS0001", { listing: LISTING });

    const vacancies = await VacancyService.listPublic({ institutionId: "INS0001" });

    expect(vacancies).toHaveLength(1);
    const serialised = JSON.stringify(vacancies);
    for (const leak of ["ef-job-1", "vac-1", "AGGREGATED", "claimed", "rejected the district"]) {
      expect(serialised).not.toContain(leak);
    }
    expect(vacancies![0]).not.toHaveProperty("listing");
    expect(Object.keys(vacancies![0]).sort()).toEqual([
      "benefits",
      "description",
      "experienceRequired",
      "id",
      "postedAt",
      "salaryMax",
      "salaryMin",
      "subject",
      "title",
    ]);
  });

  // NOT mutation-distinguishing for the projection's guard, and deliberately
  // not labelled as if it were: deleting `toPublicVacancy`'s status check
  // leaves this green, because the service query filters `status: "OPEN"`
  // first. Verified by running that mutation. The projection's own guard is
  // covered directly in `tests/unit/public-vacancy-projection.test.ts`; what
  // THIS test pins is the service query.
  it("the service query publishes OPEN only — never DRAFT, FILLED or CLOSED", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    await makeVacancy("INS0001", { status: "OPEN", title: "Open Role" });
    await makeVacancy("INS0001", { status: "DRAFT", title: "Draft Role" });
    await makeVacancy("INS0001", { status: "FILLED", title: "Filled Role" });
    await makeVacancy("INS0001", { status: "CLOSED", title: "Closed Role" });

    const vacancies = await VacancyService.listPublic({ institutionId: "INS0001" });

    expect(vacancies!.map((v) => v.title)).toEqual(["Open Role"]);
  });

  it("MUTATION-DISTINGUISHING: an unpublished institution is null, not an empty list", async () => {
    // `null` and `[]` mean different things to the route: null becomes a 404,
    // `[]` becomes a 200 with no roles. Collapsing them would tell the world
    // which unpublished institution ids exist.
    await makeProfiledInstitution("INS0001", { profileStatus: "DRAFT" });
    await makeVacancy("INS0001");

    expect(await VacancyService.listPublic({ institutionId: "INS0001" })).toBeNull();
  });

  it("MUTATION-DISTINGUISHING: a suspended institution is hidden even when published", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED", active: false });
    await makeVacancy("INS0001");

    expect(await VacancyService.listPublic({ institutionId: "INS0001" })).toBeNull();
  });

  it("renames facilities to benefits and omits an empty list rather than sending []", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    await makeVacancy("INS0001", { facilities: [] });

    const vacancies = await VacancyService.listPublic({ institutionId: "INS0001" });

    expect(vacancies![0]).not.toHaveProperty("facilities");
    expect(vacancies![0].benefits).toBeUndefined();
  });

  it("resolves by slug as well as by id, and scopes to the right institution", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    await makeProfiledInstitution("INS0002", { profileStatus: "PUBLISHED" });
    await makeVacancy("INS0001", { title: "Ours" });
    await makeVacancy("INS0002", { title: "Theirs" });

    const bySlug = await VacancyService.listPublic({ slug: "ins0001-institute" });

    expect(bySlug!.map((v) => v.title)).toEqual(["Ours"]);
  });
});

describe("public institution directory", () => {
  it("MUTATION-DISTINGUISHING: lists exactly what the profile route would serve", async () => {
    // The directory gate and the profile gate must not drift: a school listed
    // here whose profile 404s is a broken link on someone's website.
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    await makeProfiledInstitution("INS0002", { profileStatus: "DRAFT" });
    await makeProfiledInstitution("INS0003", { profileStatus: "PUBLISHED", active: false });

    const page = await InstitutionService.listPublicDirectory({});

    expect(page.institutions.map((i) => i.institutionId)).toEqual(["INS0001"]);
    expect(page.total).toBe(1);

    // The gate agrees with the profile route, checked rather than assumed.
    for (const id of ["INS0002", "INS0003"]) {
      expect(await InstitutionService.getPublicProfile({ institutionId: id })).toBeNull();
    }
  });

  it("MUTATION-DISTINGUISHING: the card is a small allow-list, not the whole profile", async () => {
    // A directory of 200 schools must not carry 200 contact blocks. These keys
    // are absent by design; the consumer fetches the one profile it is showing.
    await makeProfiledInstitution("INS0001", {
      profileStatus: "PUBLISHED",
      contact: { phone: "9880012345", email: "office@example.test" },
    });

    const page = await InstitutionService.listPublicDirectory({});

    const card = page.institutions[0];
    for (const absent of ["contact", "geo", "management", "media", "facilities", "achievements"]) {
      expect(card).not.toHaveProperty(absent);
    }
    expect(JSON.stringify(card)).not.toContain("9880012345");
  });

  it("MUTATION-DISTINGUISHING: clamps pageSize to the cap even when the caller asks for more", async () => {
    // The route's schema rejects an over-cap value, but the service is public
    // API too — a cap enforced at only one caller is not a cap.
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });

    const page = await InstitutionService.listPublicDirectory({
      pageSize: DIRECTORY_MAX_PAGE_SIZE + 500,
    });

    expect(page.pageSize).toBe(DIRECTORY_MAX_PAGE_SIZE);
  });

  it("filters by city case-insensitively but not by substring", async () => {
    await makeProfiledInstitution("INS0001", {
      profileStatus: "PUBLISHED",
      city: "Mysuru",
    });
    await makeProfiledInstitution("INS0002", {
      profileStatus: "PUBLISHED",
      city: "Mysuru North",
    });

    const exact = await InstitutionService.listPublicDirectory({ city: "mysuru" });

    expect(exact.institutions.map((i) => i.institutionId)).toEqual(["INS0001"]);
  });

  it("paginates with a stable total across pages", async () => {
    for (const n of ["INS0001", "INS0002", "INS0003"]) {
      await makeProfiledInstitution(n, { profileStatus: "PUBLISHED" });
    }

    const first = await InstitutionService.listPublicDirectory({ page: 1, pageSize: 2 });
    const second = await InstitutionService.listPublicDirectory({ page: 2, pageSize: 2 });

    expect(first.institutions).toHaveLength(2);
    expect(second.institutions).toHaveLength(1);
    expect(first.total).toBe(3);
    expect(second.total).toBe(3);
    // No overlap — the skip is doing its job.
    const ids = [...first.institutions, ...second.institutions].map((i) => i.institutionId);
    expect(new Set(ids).size).toBe(3);
  });
});
