import { describe, expect, it } from "vitest";
import { toPublicVacancy } from "@/lib/vacancies/public-projection";

/**
 * These call the projection DIRECTLY, and that is the whole point of the file.
 *
 * The integration tests in `public-directory-and-vacancies.test.ts` go through
 * `VacancyService.listPublic`, whose query already filters `status: "OPEN"` —
 * so deleting the projection's own status guard leaves every one of them
 * green. It was labelled MUTATION-DISTINGUISHING there and was not: the
 * service filter was doing the work, and the second guard was untested.
 *
 * The projection's status check is defence in depth, and defence in depth can
 * only be tested by removing the first line of defence. That means bypassing
 * the service, which is what these do.
 */

const OPEN = {
  _id: "6a887abd755db527bea51204",
  status: "OPEN",
  title: "Mathematics Teacher",
  subject: "Mathematics",
  description: "Teaching Grades 8 to 10.",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("toPublicVacancy", () => {
  it("MUTATION-DISTINGUISHING: refuses a non-OPEN vacancy even when the caller hands it one", () => {
    // No service filter in front of it — if the guard goes, these project.
    for (const status of ["DRAFT", "FILLED", "CLOSED"]) {
      expect(toPublicVacancy({ ...OPEN, status })).toBeNull();
    }
    expect(toPublicVacancy(OPEN)).not.toBeNull();
  });

  it("MUTATION-DISTINGUISHING: withholds the listing sub-document handed straight to it", () => {
    const projected = toPublicVacancy({
      ...OPEN,
      listing: {
        jobId: "ef-job-1",
        externalJobId: "vac-1",
        contract: "AGGREGATED",
        claimState: "claimed",
        blockedReason: "eduFleet rejected the district",
      },
    });

    expect(projected).not.toHaveProperty("listing");
    expect(JSON.stringify(projected)).not.toContain("ef-job-1");
  });

  it("MUTATION-DISTINGUISHING: drops a vacancy missing a required advertisable field", () => {
    // Unreachable through the product — the schema marks all three required —
    // so only a hand-edited or partially-migrated document gets here. Without
    // this, a careers page renders an empty card.
    expect(toPublicVacancy({ ...OPEN, title: "   " })).toBeNull();
    expect(toPublicVacancy({ ...OPEN, subject: undefined })).toBeNull();
    expect(toPublicVacancy({ ...OPEN, description: "" })).toBeNull();
  });

  it("dates the advert from createdAt, so editing a typo does not re-date it", () => {
    const projected = toPublicVacancy({
      ...OPEN,
      updatedAt: new Date("2026-12-25T00:00:00.000Z"),
    });

    expect(projected!.postedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});
