export const INSTITUTION_TYPES = [
  "SCHOOL",
  "PU_COLLEGE",
  "DEGREE_COLLEGE",
  "ENGINEERING_COLLEGE",
  "MEDICAL_COLLEGE",
  "UNIVERSITY",
  "OTHER",
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
};

export const USER_ROLES = ["SUPER_ADMIN", "INSTITUTION_ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

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
/** Login attempts allowed per IP + email pair. */
export const LOGIN_RATE_LIMIT = { limit: 8, windowSeconds: 300 };
