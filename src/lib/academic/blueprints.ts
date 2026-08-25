import {
  ACADEMIC_SEGMENTS,
  type AcademicLevelKey,
  type AcademicSegment,
  type InstitutionType,
} from "@/lib/constants";

export type AcademicLevel = {
  key: AcademicLevelKey;
  /** Singular, used as a field label: "Branch". */
  label: string;
  /** Used in headings and empty states: "Branches". */
  plural: string;
  /**
   * Placeholder text for the add input. This is the only place in `src/` where
   * a real-world value like "PCMB" is allowed to appear.
   */
  example: string;
};

export type AcademicBlueprint = {
  levels: AcademicLevel[];
  /**
   * The tier that answers "what do you offer" — the one worth publishing on a
   * profile. For a school that is the class; for a PU college the combination,
   * not the year; for an engineering college the branch, not the programme.
   */
  offeringDepth: number;
};

/**
 * Segment → the tiers it is made of. This map names *tiers*, never *values*:
 * adding a thirteenth institution type later is one entry here and no change to
 * the model, the service, the routes, the editor, or the fee module.
 */
export const ACADEMIC_BLUEPRINTS: Record<AcademicSegment, AcademicBlueprint> = {
  SCHOOL: {
    levels: [{ key: "CLASS", label: "Class", plural: "Classes", example: "Grade 1" }],
    offeringDepth: 0,
  },
  PRE_UNIVERSITY: {
    levels: [
      { key: "PU_YEAR", label: "PU year", plural: "PU years", example: "PUC 1st Year" },
      { key: "COMBINATION", label: "Combination", plural: "Combinations", example: "PCMB" },
    ],
    offeringDepth: 1,
  },
  DEGREE: {
    levels: [
      { key: "COURSE", label: "Course", plural: "Courses", example: "B.Com" },
      { key: "YEAR", label: "Year / semester", plural: "Years / semesters", example: "Year 1" },
    ],
    offeringDepth: 0,
  },
  ENGINEERING: {
    levels: [
      { key: "PROGRAMME", label: "Programme", plural: "Programmes", example: "B.E." },
      {
        key: "BRANCH",
        label: "Branch",
        plural: "Branches",
        example: "Computer Science & Engineering",
      },
      { key: "YEAR", label: "Year / semester", plural: "Years / semesters", example: "Year 1" },
    ],
    offeringDepth: 1,
  },
  POLYTECHNIC: {
    levels: [
      {
        key: "COURSE",
        label: "Diploma course",
        plural: "Diploma courses",
        example: "Diploma in Mechanical Engineering",
      },
      { key: "YEAR", label: "Year / semester", plural: "Years / semesters", example: "Year 1" },
    ],
    offeringDepth: 0,
  },
  UNIVERSITY: {
    levels: [
      {
        key: "PROGRAMME_LEVEL",
        label: "Programme level",
        plural: "Programme levels",
        example: "Undergraduate",
      },
      { key: "COURSE", label: "Course", plural: "Courses", example: "B.Sc" },
      {
        key: "SPECIALISATION",
        label: "Specialisation",
        plural: "Specialisations",
        example: "Computer Science",
      },
      { key: "YEAR", label: "Year / semester", plural: "Years / semesters", example: "Semester 1" },
    ],
    offeringDepth: 1,
  },
  COACHING: {
    levels: [
      { key: "PROGRAMME", label: "Programme", plural: "Programmes", example: "NEET Repeater" },
      { key: "BATCH", label: "Batch", plural: "Batches", example: "Morning Batch" },
    ],
    offeringDepth: 0,
  },
  OTHER: {
    levels: [
      { key: "PROGRAMME", label: "Programme", plural: "Programmes", example: "Certificate Course" },
    ],
    offeringDepth: 0,
  },
};

/**
 * The display separator between a unit and its parent. Defined here rather than
 * in the service because client components need it too, and the service is
 * `server-only` — a value import from there would pull `server-only` into the
 * client bundle and fail the build.
 */
export const PATH_SEPARATOR = " › ";

export function blueprintFor(segment: AcademicSegment): AcademicBlueprint {
  return ACADEMIC_BLUEPRINTS[segment];
}

/** `null` past the end of the blueprint — a depth no level exists for. */
export function levelFor(segment: AcademicSegment, depth: number): AcademicLevel | null {
  return ACADEMIC_BLUEPRINTS[segment].levels[depth] ?? null;
}

export function maxDepthFor(segment: AcademicSegment): number {
  return ACADEMIC_BLUEPRINTS[segment].levels.length - 1;
}

/**
 * Seeds the initial selection from the institution type an institution already
 * has. A default, never a constraint: the selection is stored and edited
 * independently, and changing `institutionType` later never rewrites it.
 */
export const DEFAULT_SEGMENTS_FOR_TYPE: Record<InstitutionType, AcademicSegment[]> = {
  SCHOOL: ["SCHOOL"],
  PU_COLLEGE: ["PRE_UNIVERSITY"],
  DEGREE_COLLEGE: ["DEGREE"],
  ENGINEERING_COLLEGE: ["ENGINEERING"],
  MEDICAL_COLLEGE: ["DEGREE"],
  UNIVERSITY: ["UNIVERSITY"],
  OTHER: ["OTHER"],
  B_ED_COLLEGE: ["DEGREE"],
  NURSING_COLLEGE: ["DEGREE"],
  POLYTECHNIC: ["POLYTECHNIC"],
  COACHING_INSTITUTION: ["COACHING"],
  TRAINING_INSTITUTION: ["COACHING"],
};

export function defaultSegmentsFor(institutionType: string): AcademicSegment[] {
  return DEFAULT_SEGMENTS_FOR_TYPE[institutionType as InstitutionType] ?? ["OTHER"];
}

/**
 * Declaration order, always. A stored selection is a set; only declaration
 * order is stable enough to derive a published array from. Unknown values are
 * dropped rather than passed through.
 */
export function orderSegments(segments: readonly string[]): AcademicSegment[] {
  return ACADEMIC_SEGMENTS.filter((segment) => segments.includes(segment));
}
