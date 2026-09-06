import { describe, it, expect } from "vitest";
import { toHubScholarshipPayload } from "@/lib/connectors/scholarship-hub-mapping";

const doc = {
  name: "Infinity Merit", summary: "Merit award", description: "x".repeat(220),
  categories: ["merit"], amount: "Up to ₹50,000",
  benefits: { amountMin: 10000, tuitionWaiver: true },
  criteria: "Top 10% of the class\nResident of Karnataka",
  eligibility: { stateCodes: ["KA"], genders: ["female"] },
  applicationMode: "platform",
  requiredDocuments: [{ key: "marksheet", label: "Marksheet", required: true }],
  dates: { closesAt: new Date("2026-12-31T00:00:00.000Z") },
};

// Fully-populated fixture: exercises every identity-passthrough field so each
// one is pinned by its own assertion below (mutation-distinguishing per field).
const fullDoc = {
  name: "Infinity Merit",
  summary: "Merit award",
  description: "x".repeat(220),
  categories: ["merit"],
  tags: ["stem", "girls"],
  amount: "Up to ₹50,000",
  benefits: { amountMin: 10000, tuitionWaiver: true },
  criteria: "Top 10% of the class\nResident of Karnataka",
  eligibility: { stateCodes: ["KA"], genders: ["female"] },
  applicationMode: "external" as const,
  externalUrl: "https://example.org/apply",
  requiredDocuments: [{ key: "marksheet", label: "Marksheet", required: true }],
  customQuestions: [{ key: "essay", label: "Why do you deserve this?", type: "text" }],
  applicationSteps: ["Register", "Upload documents", "Submit"],
  selectionProcess: "Shortlist then interview",
  terms: "Non-transferable award",
  faqs: [{ q: "Is this renewable?", a: "Yes, annually." }],
  sourceUrl: "https://source.example.org/scholarship/infinity-merit",
  dates: { closesAt: new Date("2026-12-31T00:00:00.000Z") },
};

describe("toHubScholarshipPayload", () => {
  it("maps name→title, amount→benefits.amountText, criteria→eligibility.otherCriteria, class link→classesOrCourses", () => {
    const p = toHubScholarshipPayload(doc as never, "Grade 10") as Record<string, any>;
    expect(p.title).toBe("Infinity Merit");                       // (a)
    expect(p.benefits.amountText).toBe("Up to ₹50,000");          // (b)
    expect(p.benefits.amountMin).toBe(10000);                     // (c)
    expect(p.eligibility.otherCriteria).toEqual(["Top 10% of the class", "Resident of Karnataka"]); // (d)
    expect(p.eligibility.classesOrCourses).toEqual(["Grade 10"]); // (e)
    expect(p.eligibility.stateCodes).toEqual(["KA"]);             // (f)
    expect(p.dates.closesAt).toBe("2026-12-31T00:00:00.000Z");    // (h) Date → ISO
  });

  // FINDING 1 fix: prove passthrough of a NON-default applicationMode, so a
  // hardcoded "platform" return would fail this (unlike the old confounded
  // assertion, which used a fixture whose applicationMode already was "platform").
  it("passes through a non-default applicationMode instead of hardcoding it", () => {
    const p = toHubScholarshipPayload(fullDoc as never) as Record<string, any>;
    expect(p.applicationMode).toBe("external");
  });

  // Separate case proving the "platform" default applies only when the doc
  // truly has no applicationMode.
  it("defaults applicationMode to platform when the doc has none", () => {
    const { applicationMode, ...withoutMode } = doc;
    const p = toHubScholarshipPayload(withoutMode as never) as Record<string, any>;
    expect(p.applicationMode).toBe("platform");
  });

  // FINDING 2 fix: one assertion per identity-passthrough field, so deleting
  // any single mapping line in the builder fails a specific assertion here.
  it("maps every identity-passthrough field verbatim", () => {
    const p = toHubScholarshipPayload(fullDoc as never) as Record<string, any>;
    expect(p.summary).toBe("Merit award");
    expect(p.description).toBe("x".repeat(220));
    expect(p.categories).toEqual(["merit"]);
    expect(p.tags).toEqual(["stem", "girls"]);
    expect(p.externalUrl).toBe("https://example.org/apply");
    expect(p.requiredDocuments).toEqual([{ key: "marksheet", label: "Marksheet", required: true }]);
    expect(p.customQuestions).toEqual([{ key: "essay", label: "Why do you deserve this?", type: "text" }]);
    expect(p.applicationSteps).toEqual(["Register", "Upload documents", "Submit"]);
    expect(p.selectionProcess).toBe("Shortlist then interview");
    expect(p.terms).toBe("Non-transferable award");
    expect(p.faqs).toEqual([{ q: "Is this renewable?", a: "Yes, annually." }]);
    expect(p.sourceUrl).toBe("https://source.example.org/scholarship/infinity-merit");
  });

  it("emits no lead/applicant fields and no undefined keys", () => {
    const p = toHubScholarshipPayload(doc as never) as Record<string, unknown>;
    expect(Object.values(p).every((v) => v !== undefined)).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/lead|applicant|phone|email/i);
  });
});
