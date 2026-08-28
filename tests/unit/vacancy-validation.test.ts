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
});

describe("vacancyPatchSchema", () => {
  it("makes every field optional", () => {
    expect(vacancyPatchSchema.parse({})).toEqual({});
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
});
