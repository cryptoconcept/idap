export type CompletionGroup = {
  key: string;
  label: string;
  weight: number;
  earned: number;
  missing: string[];
};

export type ProfileCompletion = {
  percent: number;
  groups: CompletionGroup[];
  missing: string[];
};

type Doc = Record<string, unknown>;

const filled = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
};

type Check = { label: string; done: (doc: Doc) => boolean };

type GroupSpec = { key: string; label: string; weight: number; checks: Check[] };

/**
 * The single weight table. Any surface that shows a completion percentage
 * derives it from here, so the dashboard and the API cannot disagree.
 */
const GROUPS: GroupSpec[] = [
  {
    key: "identity",
    label: "Basic information",
    weight: 15,
    checks: [
      { label: "Institution name", done: (d) => filled(d.institutionName) },
      { label: "Institution type", done: (d) => filled(d.institutionType) },
      { label: "Description", done: (d) => filled(d.description) },
      { label: "Year established", done: (d) => filled(d.establishedYear) },
    ],
  },
  {
    key: "contact",
    label: "Contact",
    weight: 12,
    checks: [
      { label: "Phone number", done: (d) => filled(d.phone) },
      { label: "Email address", done: (d) => filled(d.email) },
      { label: "Contact person", done: (d) => filled(d.contactPerson) },
    ],
  },
  {
    key: "address",
    label: "Address",
    weight: 12,
    checks: [
      { label: "Street address", done: (d) => filled(d.address) },
      { label: "City", done: (d) => filled(d.city) },
      { label: "District", done: (d) => filled(d.district) },
      { label: "State", done: (d) => filled(d.state) },
      { label: "Pincode", done: (d) => filled(d.pincode) },
    ],
  },
  {
    key: "academic",
    label: "Academic information",
    weight: 15,
    checks: [
      { label: "Board or affiliation", done: (d) => filled((d.academic as Record<string, unknown> | undefined)?.board) },
      {
        label: "Classes or courses offered",
        done: (d) => filled((d.academic as Record<string, unknown> | undefined)?.classesOffered) || filled((d.academic as Record<string, unknown> | undefined)?.coursesOffered),
      },
    ],
  },
  {
    key: "management",
    label: "Management",
    weight: 10,
    checks: [
      { label: "Management type", done: (d) => filled((d.management as Record<string, unknown> | undefined)?.managementType) },
      { label: "Principal or head", done: (d) => filled((d.management as Record<string, unknown> | undefined)?.principalName) },
    ],
  },
  {
    key: "facilities",
    label: "Facilities",
    weight: 10,
    checks: [{ label: "At least three facilities", done: (d) => ((d.facilities as unknown[] | undefined)?.length ?? 0) >= 3 }],
  },
  {
    key: "logo",
    label: "Logo",
    weight: 10,
    checks: [{ label: "Logo image", done: (d) => filled(d.logoUrl) }],
  },
  {
    key: "cover",
    label: "Cover image",
    weight: 8,
    checks: [{ label: "Cover image", done: (d) => filled(d.coverImageUrl) }],
  },
  {
    key: "social",
    label: "Social links",
    weight: 8,
    checks: [
      {
        label: "At least two social links",
        done: (d) => {
          const s = (d.social as Record<string, unknown> | undefined) ?? {};
          const named = ["facebook", "instagram", "youtube", "linkedin", "x"].filter((k) =>
            filled(s[k]),
          ).length;
          return named + ((s.other as unknown[] | undefined)?.length ?? 0) >= 2;
        },
      },
    ],
  },
];

export function calculateCompletion(institution: Doc): ProfileCompletion {
  const doc = institution ?? {};

  const groups: CompletionGroup[] = GROUPS.map((spec) => {
    const missing = spec.checks.filter((check) => !check.done(doc)).map((check) => check.label);
    const done = spec.checks.length - missing.length;
    // Proportional credit, truncated — never rounded up, never padded.
    const earned = Math.floor((done / spec.checks.length) * spec.weight);
    return { key: spec.key, label: spec.label, weight: spec.weight, earned, missing };
  });

  const percent = Math.min(
    100,
    groups.reduce((sum, group) => sum + group.earned, 0),
  );

  return { percent, groups, missing: groups.flatMap((group) => group.missing) };
}
