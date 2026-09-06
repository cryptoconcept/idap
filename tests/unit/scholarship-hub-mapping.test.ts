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

describe("toHubScholarshipPayload", () => {
  it("maps name→title, amount→benefits.amountText, criteria→eligibility.otherCriteria, class link→classesOrCourses", () => {
    const p = toHubScholarshipPayload(doc as never, "Grade 10") as Record<string, any>;
    expect(p.title).toBe("Infinity Merit");                       // (a)
    expect(p.benefits.amountText).toBe("Up to ₹50,000");          // (b)
    expect(p.benefits.amountMin).toBe(10000);                     // (c)
    expect(p.eligibility.otherCriteria).toEqual(["Top 10% of the class", "Resident of Karnataka"]); // (d)
    expect(p.eligibility.classesOrCourses).toEqual(["Grade 10"]); // (e)
    expect(p.eligibility.stateCodes).toEqual(["KA"]);             // (f)
    expect(p.applicationMode).toBe("platform");                   // (g)
    expect(p.dates.closesAt).toBe("2026-12-31T00:00:00.000Z");    // (h) Date → ISO
  });
  it("emits no lead/applicant fields and no undefined keys", () => {
    const p = toHubScholarshipPayload(doc as never) as Record<string, unknown>;
    expect(Object.values(p).every((v) => v !== undefined)).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/lead|applicant|phone|email/i);
  });
});
