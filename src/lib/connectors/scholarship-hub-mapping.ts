type ScholarshipLike = {
  name: string; summary?: string; description?: string; categories?: string[]; tags?: string[];
  amount?: string; criteria?: string;
  benefits?: { amountMin?: number; amountMax?: number; stipendMonthly?: number; awards?: number; tuitionWaiver?: boolean };
  eligibility?: Record<string, unknown> & { otherCriteria?: string[]; classesOrCourses?: string[] };
  applicationMode?: "platform" | "external"; externalUrl?: string;
  requiredDocuments?: unknown[]; customQuestions?: unknown[]; applicationSteps?: string[];
  dates?: { opensAt?: Date | string; closesAt?: Date | string; resultAt?: Date | string };
  selectionProcess?: string; terms?: string; faqs?: unknown[]; sourceUrl?: string;
};
const iso = (d?: Date | string) => (d == null ? undefined : new Date(d).toISOString());
const dropUndefined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function toHubScholarshipPayload(s: ScholarshipLike, classOrCourse?: string): Record<string, unknown> {
  const otherCriteria = s.criteria ? s.criteria.split("\n").map((l) => l.trim()).filter(Boolean) : undefined;
  const classesOrCourses = classOrCourse ? [classOrCourse] : (s.eligibility?.classesOrCourses as string[] | undefined);
  return dropUndefined({
    title: s.name,
    summary: s.summary,
    description: s.description,
    categories: s.categories,
    tags: s.tags,
    benefits: dropUndefined({ ...(s.benefits ?? {}), amountText: s.amount || undefined }),
    eligibility: dropUndefined({ ...(s.eligibility ?? {}), otherCriteria: otherCriteria ?? (s.eligibility?.otherCriteria), classesOrCourses }),
    applicationMode: s.applicationMode ?? "platform",
    externalUrl: s.externalUrl,
    requiredDocuments: s.requiredDocuments,
    customQuestions: s.customQuestions,
    applicationSteps: s.applicationSteps,
    dates: s.dates ? dropUndefined({ opensAt: iso(s.dates.opensAt), closesAt: iso(s.dates.closesAt), resultAt: iso(s.dates.resultAt) }) : undefined,
    selectionProcess: s.selectionProcess,
    terms: s.terms,
    faqs: s.faqs,
    sourceUrl: s.sourceUrl,
  });
}
