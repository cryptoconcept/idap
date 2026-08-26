import { describe, expect, it } from "vitest";
import {
  assertPublishable,
  assertResultInvariants,
  createResultSchema,
  updateResultSchema,
} from "@/lib/validation/result";

const base = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  academicYear: "2025-26",
  appeared: 100,
  passed: 100,
};

describe("result invariants", () => {
  it("accepts a coherent record", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [
          { label: "90%+", minPercentage: 90, maxPercentage: 100, count: 30 },
          { label: "75-90%", minPercentage: 75, maxPercentage: 89, count: 40 },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses more passes than appeared", () => {
    expect(() => assertResultInvariants({ ...base, appeared: 10, passed: 11 })).toThrow(
      /cannot exceed/i,
    );
  });

  it("refuses overlapping bands", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [
          { label: "A", minPercentage: 80, maxPercentage: 100, count: 1 },
          { label: "B", minPercentage: 75, maxPercentage: 85, count: 1 },
        ],
      }),
    ).toThrow(/overlap/i);
  });

  it("refuses a band whose minimum exceeds its maximum", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        bands: [{ label: "A", minPercentage: 90, maxPercentage: 80, count: 1 }],
      }),
    ).toThrow(/lower than/i);
  });

  it("refuses band counts adding up to more than appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 10,
        passed: 10,
        bands: [
          { label: "A", minPercentage: 90, maxPercentage: 100, count: 6 },
          { label: "B", minPercentage: 75, maxPercentage: 89, count: 6 },
        ],
      }),
    ).toThrow(/more students than appeared/i);
  });

  it("requires boardName when the board does not name itself", () => {
    expect(() => assertResultInvariants({ ...base, board: "STATE_BOARD" })).toThrow(/boardName/);
    expect(() =>
      assertResultInvariants({ ...base, board: "STATE_BOARD", boardName: "Karnataka State Board" }),
    ).not.toThrow();
  });

  it("does not require boardName for a board that names itself", () => {
    expect(() => assertResultInvariants({ ...base, board: "CBSE" })).not.toThrow();
  });
});

describe("publish gate", () => {
  it("refuses to publish a cycle with nobody appearing", () => {
    expect(() => assertPublishable({ ...base, appeared: 0, passed: 0 })).toThrow(/appeared/i);
  });

  it("refuses to publish while any topper lacks acknowledged consent", () => {
    expect(() =>
      assertPublishable({
        ...base,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: false },
        ],
      }),
    ).toThrow(/Rahul K/);
  });

  it("publishes when every topper has acknowledged consent", () => {
    expect(() =>
      assertPublishable({
        ...base,
        toppers: [{ name: "Priya S", percentage: 98.6, consentAcknowledged: true }],
      }),
    ).not.toThrow();
  });

  it("still applies the ordinary invariants at publish time", () => {
    expect(() => assertPublishable({ ...base, appeared: 10, passed: 11 })).toThrow(/cannot exceed/i);
  });
});

describe("result schemas", () => {
  it("accepts a minimal create body", () => {
    const parsed = createResultSchema.parse({
      board: "CBSE",
      level: "CLASS_10",
      academicYear: "2025-26",
      appeared: 100,
      passed: 98,
    });
    expect(parsed.stream).toBeNull();
  });

  it("normalises a missing stream to null so the unique index sees one value", () => {
    expect(createResultSchema.parse({ ...base }).stream).toBeNull();
  });

  it("refuses a photoUrl on create — photos are set only by the upload endpoint", () => {
    const parsed = createResultSchema.parse({
      ...base,
      toppers: [{ name: "Priya S", percentage: 98.6, photoUrl: "https://evil.example/x.png" }],
    });
    expect(parsed.toppers?.[0]).not.toHaveProperty("photoUrl");
  });

  it("refuses a photoUrl on patch", () => {
    const parsed = updateResultSchema.parse({
      toppers: [{ name: "Priya S", percentage: 98.6, photoUrl: "https://evil.example/x.png" }],
    });
    expect(parsed.toppers?.[0]).not.toHaveProperty("photoUrl");
  });

  it("refuses a status on patch — status moves only through the publish route", () => {
    const parsed = updateResultSchema.parse({ status: "PUBLISHED" });
    expect(parsed).not.toHaveProperty("status");
  });

  it("rejects a percentage outside 0-100", () => {
    expect(() => createResultSchema.parse({ ...base, averageScore: 101 })).toThrow();
  });

  it("caps the number of toppers", () => {
    const toppers = Array.from({ length: 26 }, (_, i) => ({ name: `S${i}`, percentage: 90 }));
    expect(() => createResultSchema.parse({ ...base, toppers })).toThrow();
  });
});

describe("combination invariants", () => {
  it("accepts a combination whose passed does not exceed its appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", appeared: 50, passed: 50 }],
      }),
    ).not.toThrow();
  });

  it("refuses a combination with more passed than appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", appeared: 40, passed: 50 }],
      }),
    ).toThrow(/"PCMB" has more passed than appeared/);
  });

  it("refuses combinations that together account for more than the result's appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 60,
        passed: 60,
        combinations: [
          { label: "PCMB", appeared: 40 },
          { label: "PCMC", appeared: 40 },
        ],
      }),
    ).toThrow(/the combinations account for more students than appeared/);
  });

  it("accepts combinations that under-cover the result's appeared — a partial record is normal", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 100,
        passed: 100,
        combinations: [{ label: "PCMB", appeared: 40 }],
      }),
    ).not.toThrow();
  });

  it("refuses two combinations with the same label after trimming", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB" }, { label: " PCMB " }],
      }),
    ).toThrow(/each combination needs a distinct label/);
  });

  it("refuses a combination's distinction and firstClass together exceeding its passed", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", passed: 10, distinction: 6, firstClass: 6 }],
      }),
    ).toThrow(/distinction and first class together exceed the number who passed/);
  });

  it("accepts a combination's distinction and firstClass with no passed reported", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", distinction: 3, firstClass: 3 }],
      }),
    ).not.toThrow();
  });

  it("refuses a combination's boys and girls together exceeding its appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [
          { label: "PCMB", appeared: 10, boys: { appeared: 6 }, girls: { appeared: 6 } },
        ],
      }),
    ).toThrow(/boys and girls together exceed the number who appeared/);
  });

  it("accepts a combination's boys/girls appeared with no combination.appeared reported", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [
          { label: "PCMB", boys: { appeared: 6 }, girls: { appeared: 6 } },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses a combination's boys.passed exceeding boys.appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", boys: { appeared: 5, passed: 6 } }],
      }),
    ).toThrow(/boys: more passed than appeared/);
  });

  it("refuses grade bucket counts exceeding a combination's appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [
          { label: "PCMB", appeared: 10, grades: { "90+": 6, "80-90": 6 } },
        ],
      }),
    ).toThrow(/the grade bands account for more students than appeared/);
  });

  it("accepts grade bucket counts with no combination.appeared reported", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        combinations: [{ label: "PCMB", grades: { "90+": 6, "80-90": 6 } }],
      }),
    ).not.toThrow();
  });
});

describe("result-level distinction/firstClass and gender-split invariants", () => {
  it("refuses distinction and firstClass together exceeding the result's own passed", () => {
    expect(() =>
      assertResultInvariants({ ...base, passed: 10, distinction: 6, firstClass: 6 }),
    ).toThrow(/distinction and first class together exceed the number who passed/);
  });

  it("refuses the result's own boys and girls together exceeding appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        appeared: 10,
        boys: { appeared: 6 },
        girls: { appeared: 6 },
      }),
    ).toThrow(/boys and girls together exceed the number who appeared/);
  });

  it("accepts a boys/girls split that reports passed with no appeared", () => {
    expect(() => assertResultInvariants({ ...base, girls: { passed: 5 } })).not.toThrow();
  });
});

describe("placement invariants", () => {
  it("accepts placed not exceeding eligible", () => {
    expect(() =>
      assertResultInvariants({ ...base, placement: { eligible: 50, placed: 50 } }),
    ).not.toThrow();
  });

  it("refuses more placed than eligible", () => {
    expect(() =>
      assertResultInvariants({ ...base, placement: { eligible: 40, placed: 50 } }),
    ).toThrow(/more students placed than were eligible/);
  });

  it("refuses named recruiters accounting for more selections than the placed total", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        placement: {
          placed: 10,
          recruiters: [{ name: "Acme", selected: 6 }, { name: "Globex", selected: 6 }],
        },
      }),
    ).toThrow(/the named recruiters account for more selections than the placed total/);
  });

  it("accepts recruiters reporting selected with no placement.placed reported", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        placement: { recruiters: [{ name: "Acme", selected: 5 }] },
      }),
    ).not.toThrow();
  });

  it("refuses an average package exceeding the highest package", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        placement: { highestPackage: 10, averagePackage: 15 },
      }),
    ).toThrow(/the average package cannot exceed the highest/);
  });

  it("refuses two recruiters with the same name after trimming", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        placement: { recruiters: [{ name: "Acme" }, { name: " Acme " }] },
      }),
    ).toThrow(/each recruiter needs a distinct name/);
  });
});

describe("selection invariants", () => {
  it("accepts qualified not exceeding appeared", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        selections: [{ examCode: "KCET", appeared: 40, qualified: 40 }],
      }),
    ).not.toThrow();
  });

  it("refuses more qualified than appeared for one exam", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        selections: [{ examCode: "KCET", appeared: 30, qualified: 40 }],
      }),
    ).toThrow(/KCET has more qualified than appeared/);
  });

  it("refuses the same exam listed twice", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        selections: [{ examCode: "KCET", qualified: 1 }, { examCode: "KCET", qualified: 2 }],
      }),
    ).toThrow(/each exam can appear only once/);
  });

  it("accepts a selection's qualified count exceeding the result's own passed — different cohorts", () => {
    expect(() =>
      assertResultInvariants({
        ...base,
        passed: 5,
        selections: [{ examCode: "NEET", qualified: 50 }],
      }),
    ).not.toThrow();
  });
});
