import { describe, it, expect } from "vitest";
import { VACANCY_SUBJECTS, VACANCY_BENEFITS, VACANCY_SUBJECT_GROUPS } from "@/lib/constants";
import { vacancyCreateSchema, vacancyPatchSchema } from "@/lib/validation/vacancy";

describe("vacancy vocabularies", () => {
  // Transcribed from eduFleet's web/src/lib/taxonomy.ts (JOB_CATEGORIES), in
  // source order. Not read at runtime: that repo is a sibling checkout absent
  // on CI, so a runtime read would error rather than compare. Verified against
  // docs/integrations/edufleet-api-map.md §6.1.
  it("matches eduFleet's 16 job subjects verbatim, in source order", () => {
    expect(VACANCY_SUBJECTS).toEqual([
      "Mathematics", "Physics", "Chemistry", "Biology",
      "English", "Kannada", "Hindi", "Social Science",
      "Principal", "Vice Principal", "Coordinator", "Administrator",
      "Accountant", "Clerk", "Driver", "Librarian",
    ]);
  });

  it("partitions every subject into exactly one group", () => {
    const grouped = VACANCY_SUBJECT_GROUPS.flatMap((g) => g.subjects);
    expect(grouped).toEqual([...VACANCY_SUBJECTS]);
    expect(VACANCY_SUBJECT_GROUPS.map((g) => g.subjects.length)).toEqual([8, 4, 4]);
  });

  // Transcribed from eduFleet's web/src/lib/job-facilities.ts (JOB_FACILITIES).
  // Verified against docs/integrations/edufleet-api-map.md §6.2.
  it("matches eduFleet's 11 benefit labels verbatim", () => {
    expect(VACANCY_BENEFITS).toEqual([
      "Provident Fund (PF)", "ESI (medical insurance)", "Gratuity", "Health insurance",
      "Staff accommodation", "Transport / bus facility", "Free / subsidised meals",
      "Paid leave", "Annual / festival bonus", "Training & development",
      "Maternity benefits",
    ]);
  });
});

describe("vacancyCreateSchema", () => {
  const valid = { title: "Maths Teacher", subject: "Mathematics", description: "Teach CBSE Grade 8-10." };

  it("accepts a minimal valid vacancy", () => {
    expect(vacancyCreateSchema.parse(valid).title).toBe("Maths Teacher");
  });

  it("requires title", () => {
    const { title: _title, ...rest } = valid;
    expect(() => vacancyCreateSchema.parse(rest)).toThrow();
  });

  it("requires subject", () => {
    const { subject: _subject, ...rest } = valid;
    expect(() => vacancyCreateSchema.parse(rest)).toThrow();
  });

  it("requires description", () => {
    const { description: _description, ...rest } = valid;
    expect(() => vacancyCreateSchema.parse(rest)).toThrow();
  });

  it("rejects a title over 120 characters", () => {
    expect(() => vacancyCreateSchema.parse({ ...valid, title: "a".repeat(121) })).toThrow();
  });

  it("rejects a description over 2000 characters", () => {
    expect(() => vacancyCreateSchema.parse({ ...valid, description: "a".repeat(2001) })).toThrow();
  });

  it("rejects an unknown subject", () => {
    expect(() => vacancyCreateSchema.parse({ ...valid, subject: "Astrology" })).toThrow(/subject/i);
  });

  it("rejects an unknown benefit", () => {
    expect(() => vacancyCreateSchema.parse({ ...valid, facilities: ["Free chai"] })).toThrow(/facilit/i);
  });

  it("rejects salaryMin greater than salaryMax", () => {
    expect(() => vacancyCreateSchema.parse({ ...valid, salaryMin: 50000, salaryMax: 30000 })).toThrow(/salary/i);
  });

  it("accepts salaryMin alone", () => {
    expect(vacancyCreateSchema.parse({ ...valid, salaryMin: 20000 }).salaryMin).toBe(20000);
  });

  it("accepts salaryMax alone", () => {
    expect(vacancyCreateSchema.parse({ ...valid, salaryMax: 60000 }).salaryMax).toBe(60000);
  });

  it("accepts a zero salaryMin as a real value", () => {
    expect(vacancyCreateSchema.parse({ ...valid, salaryMin: 0 }).salaryMin).toBe(0);
  });

  // Follows the same `.refine(v => new Set(v).size === v.length, ...)` idiom
  // as `academic-structure.ts`'s `updateSegmentsSchema` and
  // `fee-structure.ts`'s `distinctObjectIds` — `.max()` alone counts entries,
  // not distinct values, so `["Gratuity","Gratuity"]` would otherwise pass
  // and the dashboard would render two badges sharing one React key.
  it("rejects duplicate facilities", () => {
    expect(() =>
      vacancyCreateSchema.parse({ ...valid, facilities: ["Gratuity", "Gratuity"] }),
    ).toThrow(/facility/i);
  });

  it("accepts each facility once", () => {
    const result = vacancyCreateSchema.parse({
      ...valid,
      facilities: ["Gratuity", "Paid leave"],
    });
    expect(result.facilities).toEqual(["Gratuity", "Paid leave"]);
  });

  // MUTATION-DISTINGUISHING: `listing` (src/models/Vacancy.ts) records what
  // eduFleet knows about a vacancy and is written only by the (future) push
  // service — never by a client. `vacancyCreateSchema` has no `listing`
  // field, so `.strict()` (src/lib/validation/vacancy.ts) is what turns that
  // absence into an outright rejection rather than a silent strip. Remove
  // `.strict()` and this passes straight through instead of throwing.
  it("MUTATION-DISTINGUISHING: rejects a listing block on create", () => {
    expect(() =>
      vacancyCreateSchema.parse({
        ...valid,
        listing: { jobId: "job-1", contract: "AGGREGATED", lastPushedAt: new Date() },
      }),
    ).toThrow();
  });
});

/**
 * Pins the custom messages on `salary` and `experience`
 * (`src/lib/validation/vacancy.ts`) so a school administrator sees copy
 * written for them rather than Zod's default "Invalid input: expected int,
 * received number" — found reading badly beside the form's own hand-written
 * salary-order toast. A revert to the default message fails these.
 */
describe("vacancyCreateSchema numeric messages", () => {
  const valid = { title: "Maths Teacher", subject: "Mathematics", description: "Teach CBSE Grade 8-10." };

  function firstMessage(result: ReturnType<typeof vacancyCreateSchema.safeParse>): string {
    if (result.success) throw new Error("expected parse to fail");
    return result.error.issues[0].message;
  }

  it("gives a readable message for a non-integer salary", () => {
    const result = vacancyCreateSchema.safeParse({ ...valid, salaryMin: 45000.5 });
    expect(firstMessage(result)).toBe("Salary must be a whole number, without decimals.");
  });

  it("gives a readable message for a negative salary", () => {
    const result = vacancyCreateSchema.safeParse({ ...valid, salaryMin: -500 });
    expect(firstMessage(result)).toBe("Salary cannot be negative.");
  });

  it("gives a readable message for a salary over the cap", () => {
    const result = vacancyCreateSchema.safeParse({ ...valid, salaryMax: 10_000_001 });
    expect(firstMessage(result)).toBe("Salary cannot exceed ₹1,00,00,000 a month.");
  });

  it("gives a readable message for a non-integer experienceRequired", () => {
    const result = vacancyCreateSchema.safeParse({ ...valid, experienceRequired: 2.5 });
    expect(firstMessage(result)).toBe("Experience must be a whole number of years.");
  });

  it("gives a readable message for a negative experienceRequired", () => {
    const result = vacancyCreateSchema.safeParse({ ...valid, experienceRequired: -1 });
    expect(firstMessage(result)).toBe("Experience cannot be negative.");
  });

  it("gives a readable message for experienceRequired over the cap", () => {
    const result = vacancyCreateSchema.safeParse({ ...valid, experienceRequired: 61 });
    expect(firstMessage(result)).toBe("Experience cannot exceed 60 years.");
  });
});

describe("vacancyPatchSchema", () => {
  it("makes every field optional", () => {
    expect(vacancyPatchSchema.parse({})).toEqual({});
  });

  // Symmetric with the create-side test in the `vacancyCreateSchema`
  // describe block above: `listing` is not a patchable field either
  // (`PATCHABLE_FIELDS` in `vacancy.service.ts` omits it too), and
  // `.strict()` is what makes an attempt to set it a hard rejection.
  it("MUTATION-DISTINGUISHING: rejects a listing block on patch", () => {
    expect(() =>
      vacancyPatchSchema.parse({
        listing: { jobId: "job-1", contract: "AGGREGATED", lastPushedAt: new Date() },
      }),
    ).toThrow();
  });

  it("distinguishes an explicit null from an absent key on salaryMin", () => {
    expect(vacancyPatchSchema.parse({ salaryMin: null }).salaryMin).toBeNull();
    expect(vacancyPatchSchema.parse({}).salaryMin).toBeUndefined();
  });

  it("distinguishes an explicit null from an absent key on salaryMax", () => {
    expect(vacancyPatchSchema.parse({ salaryMax: null }).salaryMax).toBeNull();
    expect(vacancyPatchSchema.parse({}).salaryMax).toBeUndefined();
  });

  it("distinguishes an explicit null from an absent key on experienceRequired", () => {
    expect(vacancyPatchSchema.parse({ experienceRequired: null }).experienceRequired).toBeNull();
    expect(vacancyPatchSchema.parse({}).experienceRequired).toBeUndefined();
  });

  // The concrete hazard the finding names: an API client PATCHing a
  // duplicated facility past `.max()` alone, which counts entries rather
  // than distinct values.
  it("rejects duplicate facilities on a patch", () => {
    expect(() => vacancyPatchSchema.parse({ facilities: ["Gratuity", "Gratuity"] })).toThrow(
      /facility/i,
    );
  });
});
