export const INSTITUTION_TYPES = [
  "SCHOOL",
  "PU_COLLEGE",
  "DEGREE_COLLEGE",
  "ENGINEERING_COLLEGE",
  "MEDICAL_COLLEGE",
  "UNIVERSITY",
  "OTHER",
  "B_ED_COLLEGE",
  "NURSING_COLLEGE",
  "POLYTECHNIC",
  "COACHING_INSTITUTION",
  "TRAINING_INSTITUTION",
] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export const INSTITUTION_TYPE_LABELS: Record<InstitutionType, string> = {
  SCHOOL: "School",
  PU_COLLEGE: "PU College",
  DEGREE_COLLEGE: "Degree College",
  ENGINEERING_COLLEGE: "Engineering College",
  MEDICAL_COLLEGE: "Medical College",
  UNIVERSITY: "University",
  OTHER: "Other",
  B_ED_COLLEGE: "B.Ed College",
  NURSING_COLLEGE: "Nursing College",
  POLYTECHNIC: "Polytechnic",
  COACHING_INSTITUTION: "Coaching Institution",
  TRAINING_INSTITUTION: "Training Institution",
};

export const USER_ROLES = ["SUPER_ADMIN", "INSTITUTION_ADMIN", "COUNSELOR", "FRONT_DESK"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: "Platform administrator",
  INSTITUTION_ADMIN: "Institution admin",
  COUNSELOR: "Counselor",
  FRONT_DESK: "Front desk",
};

export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "FOLLOW_UP",
  "ADMITTED",
  "REJECTED",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const APPLICATION_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "SHORTLISTED",
  "APPROVED",
  "REJECTED",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const SOURCES = ["WEBSITE", "API", "MANUAL"] as const;
export type Source = (typeof SOURCES)[number];

export const DOCUMENT_TYPES = [
  "PHOTO",
  "BIRTH_CERTIFICATE",
  "MARKSHEET",
  "TRANSFER_CERTIFICATE",
  "OTHER",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  PHOTO: "Photograph",
  BIRTH_CERTIFICATE: "Birth Certificate",
  MARKSHEET: "Marksheet",
  TRANSFER_CERTIFICATE: "Transfer Certificate",
  OTHER: "Other",
};

export const ENTITY_TYPES = ["LEAD", "APPLICATION"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const API_PERMISSIONS = [
  "CREATE_LEAD",
  "CREATE_APPLICATION",
  "READ_APPLICATION",
] as const;
export type ApiPermission = (typeof API_PERMISSIONS)[number];

export const API_PERMISSION_LABELS: Record<ApiPermission, string> = {
  CREATE_LEAD: "Create enquiries",
  CREATE_APPLICATION: "Create applications",
  READ_APPLICATION: "Read applications",
};

export const GENDERS = ["Male", "Female", "Other"] as const;

export const ADMISSION_TYPES = [
  "REGULAR",
  "MANAGEMENT",
  "TRANSFER",
  "LATERAL_ENTRY",
] as const;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Fixed-window API rate limit applied per API key. */
export const API_RATE_LIMIT = { limit: 100, windowSeconds: 60 };
/** Stricter limit for unauthenticated public (hosted form) submissions, per IP. */
export const PUBLIC_FORM_RATE_LIMIT = { limit: 10, windowSeconds: 60 };
/**
 * Public profile reads, per IP. Deliberately looser than the form limit — a
 * read is cheap and cacheable, and a whole school behind one NAT address
 * shares this bucket — and deliberately not keyed by institution: the abuse
 * it exists to stop is cache-busting through a varying id or slug.
 */
export const PUBLIC_READ_RATE_LIMIT = { limit: 60, windowSeconds: 60 };
/** Login attempts allowed per IP + email pair. */
export const LOGIN_RATE_LIMIT = { limit: 8, windowSeconds: 300 };

export const PROFILE_STATUSES = ["DRAFT", "PUBLISHED", "SUSPENDED", "ARCHIVED"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const PROFILE_STATUS_LABELS: Record<ProfileStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  SUSPENDED: "Suspended",
  ARCHIVED: "Archived",
};

export const MANAGEMENT_TYPES = [
  "GOVERNMENT",
  "AIDED",
  "UNAIDED",
  "PRIVATE",
  "TRUST",
  "SOCIETY",
  "MINORITY",
  "AUTONOMOUS",
  "OTHER",
] as const;
export type ManagementType = (typeof MANAGEMENT_TYPES)[number];

export const GENDER_TYPES = ["BOYS", "GIRLS", "CO_ED"] as const;
export type GenderType = (typeof GENDER_TYPES)[number];

export const GENDER_TYPE_LABELS: Record<GenderType, string> = {
  BOYS: "Boys only",
  GIRLS: "Girls only",
  CO_ED: "Co-educational",
};

export const GALLERY_STATUSES = ["ACTIVE", "HIDDEN"] as const;
export type GalleryStatus = (typeof GALLERY_STATUSES)[number];

/** A gallery, not a media platform. Enforced in the service, not only the UI. */
export const GALLERY_MAX_ITEMS = 60;

export const RESULT_BOARDS = [
  "CBSE",
  "ICSE",
  "ISC",
  "IB",
  "IGCSE",
  "STATE_BOARD",
  "UNIVERSITY",
  "AUTONOMOUS",
  "OTHER",
] as const;
export type ResultBoard = (typeof RESULT_BOARDS)[number];

export const RESULT_BOARD_LABELS: Record<ResultBoard, string> = {
  CBSE: "CBSE",
  ICSE: "ICSE",
  ISC: "ISC",
  IB: "International Baccalaureate",
  IGCSE: "IGCSE",
  STATE_BOARD: "State board",
  UNIVERSITY: "University",
  AUTONOMOUS: "Autonomous",
  OTHER: "Other",
};

/**
 * Boards whose enum member does not name the awarding body on its own. For
 * these, `boardName` carries the real name (e.g. "Karnataka State Board") and
 * is required.
 */
export const BOARD_NAME_REQUIRED: ReadonlySet<ResultBoard> = new Set<ResultBoard>([
  "STATE_BOARD",
  "UNIVERSITY",
  "AUTONOMOUS",
  "OTHER",
]);

export const RESULT_LEVELS = [
  "CLASS_10",
  "CLASS_12",
  "PUC_1",
  "PUC_2",
  "UG",
  "PG",
  "DIPLOMA",
  "OTHER",
] as const;
export type ResultLevel = (typeof RESULT_LEVELS)[number];

export const RESULT_LEVEL_LABELS: Record<ResultLevel, string> = {
  CLASS_10: "Class 10",
  CLASS_12: "Class 12",
  PUC_1: "PUC I",
  PUC_2: "PUC II",
  UG: "Undergraduate",
  PG: "Postgraduate",
  DIPLOMA: "Diploma",
  OTHER: "Other",
};

export const RESULT_STREAMS = ["SCIENCE", "COMMERCE", "ARTS"] as const;
export type ResultStream = (typeof RESULT_STREAMS)[number];

export const RESULT_STREAM_LABELS: Record<ResultStream, string> = {
  SCIENCE: "Science",
  COMMERCE: "Commerce",
  ARTS: "Arts",
};

export const RESULT_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const RESULT_STATUS_LABELS: Record<ResultStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const RESULT_MAX_BANDS = 8;
export const RESULT_MAX_TOPPERS = 25;

export const PERMISSIONS = [
  "LEADS_VIEW_ALL",
  "LEADS_VIEW_OWN",
  "LEADS_CREATE",
  "LEADS_UPDATE",
  "LEADS_ASSIGN",
  "LEADS_SET_FOLLOWUP",
  "LEADS_DELETE",
  "LEADS_EXPORT",
  "STAFF_MANAGE",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Who can do what. Checked once per route via `requirePermission()` — never
 * inline `role === X || role === Y` conditionals, so moving a permission
 * between roles later is a one-line edit here, not an audit of every route
 * that happens to check that role.
 *
 * `COUNSELOR`'s LEADS_UPDATE/LEADS_SET_FOLLOWUP and `FRONT_DESK`'s
 * LEADS_VIEW_OWN are further scoped at the service layer (ownership, and the
 * "mine + unassigned" filter) — this table only says which permissions a
 * role holds at all, not what document-level scoping applies.
 */
export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set([]),
  INSTITUTION_ADMIN: new Set([
    "LEADS_VIEW_ALL",
    "LEADS_VIEW_OWN",
    "LEADS_CREATE",
    "LEADS_UPDATE",
    "LEADS_ASSIGN",
    "LEADS_SET_FOLLOWUP",
    "LEADS_DELETE",
    "LEADS_EXPORT",
    "STAFF_MANAGE",
  ]),
  COUNSELOR: new Set(["LEADS_VIEW_OWN", "LEADS_UPDATE", "LEADS_SET_FOLLOWUP"]),
  FRONT_DESK: new Set(["LEADS_VIEW_OWN", "LEADS_CREATE"]),
};

export const FEE_FREQUENCIES = ["ONE_TIME", "ANNUAL"] as const;
export type FeeFrequency = (typeof FEE_FREQUENCIES)[number];

export const FEE_FREQUENCY_LABELS: Record<FeeFrequency, string> = {
  ONE_TIME: "One-time",
  ANNUAL: "Annual",
};

export const FEE_STRUCTURE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type FeeStructureStatus = (typeof FEE_STRUCTURE_STATUSES)[number];

export const FEE_STRUCTURE_STATUS_LABELS: Record<FeeStructureStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

/**
 * What an institution actually runs. Curated so every entry is a genuinely
 * different *shape* — medical, nursing and B.Ed colleges all have the shape
 * `Course → Year / semester`, so they share `DEGREE` rather than each getting
 * an entry. This is not a list of institution types.
 */
export const ACADEMIC_SEGMENTS = [
  "SCHOOL",
  "PRE_UNIVERSITY",
  "DEGREE",
  "ENGINEERING",
  "POLYTECHNIC",
  "UNIVERSITY",
  "COACHING",
  "OTHER",
] as const;
export type AcademicSegment = (typeof ACADEMIC_SEGMENTS)[number];

export const ACADEMIC_SEGMENT_LABELS: Record<AcademicSegment, string> = {
  SCHOOL: "School (up to Class 10 / SSLC)",
  PRE_UNIVERSITY: "Pre-University (PUC)",
  DEGREE: "Degree college",
  ENGINEERING: "Engineering college",
  POLYTECHNIC: "Polytechnic / Diploma",
  UNIVERSITY: "University",
  COACHING: "Coaching / Training",
  OTHER: "Other",
};

/** A tier name, shared wherever the tier genuinely is the same thing. */
export const ACADEMIC_LEVEL_KEYS = [
  "CLASS",
  "PU_YEAR",
  "COMBINATION",
  "COURSE",
  "PROGRAMME",
  "BRANCH",
  "PROGRAMME_LEVEL",
  "SPECIALISATION",
  "YEAR",
  "BATCH",
] as const;
export type AcademicLevelKey = (typeof ACADEMIC_LEVEL_KEYS)[number];

/**
 * A rename rewrites its subtree in application code and a delete collects one
 * in memory. Both are correct at tens of nodes and neither is at thousands —
 * this is the guard that keeps the assumption true.
 */
export const ACADEMIC_UNIT_MAX_PER_INSTITUTION = 500;
