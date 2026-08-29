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

/**
 * Hard ceiling on one page of the public institution directory.
 *
 * The endpoint is credential-free, so this is the only thing between a caller
 * and the whole table: `pageSize` is validated against it at the route AND
 * clamped to it again in the service, because a second caller of the service
 * would otherwise inherit no cap at all.
 */
export const DIRECTORY_MAX_PAGE_SIZE = 50;
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

export const MEDIA_KINDS = ["IMAGE", "VIDEO", "BROCHURE", "PROSPECTUS"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  IMAGE: "Photo",
  VIDEO: "Video",
  BROCHURE: "Brochure",
  PROSPECTUS: "Prospectus",
};

export const MEDIA_STATUSES = ["ACTIVE", "HIDDEN"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const MEDIA_PROVIDERS = ["YOUTUBE", "VIMEO"] as const;
export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

/** Per kind, not one shared total: sixty brochures is a data-entry error. */
export const MEDIA_MAX_ITEMS: Record<MediaKind, number> = {
  IMAGE: 60,
  VIDEO: 10,
  BROCHURE: 10,
  PROSPECTUS: 10,
};

export const MEDIA_MAX_PDF_BYTES = 20 * 1024 * 1024;

/** FeesBasket caps caption at 240 (feesbasket-api-map.md §4). Enforced at
 *  input so the value IDAP holds is always the value it can push. */
export const MEDIA_CAPTION_MAX = 240;

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
export const RESULT_MAX_COMBINATIONS = 12;
export const RESULT_MAX_RECRUITERS = 30;
/** A recruiter's hiring roles are realistically a handful of names, not dozens. */
export const RESULT_MAX_RECRUITER_ROLES = 10;

export const EXAM_CODES = ["NEET", "JEE_MAIN", "JEE_ADVANCED", "KCET", "COMEDK"] as const;
export type ExamCode = (typeof EXAM_CODES)[number];

export const EXAM_CODE_LABELS: Record<ExamCode, string> = {
  NEET: "NEET",
  JEE_MAIN: "JEE Main",
  JEE_ADVANCED: "JEE Advanced",
  KCET: "KCET",
  COMEDK: "COMEDK",
};

/** One row per exam, at most — never hand-copied, so a sixth exam here needs no second edit. */
export const RESULT_MAX_SELECTIONS = EXAM_CODES.length;

export const RECRUITER_CATEGORIES = ["IT", "PRODUCT", "CORE", "CONSULTING", "STARTUP", "OTHER"] as const;
export type RecruiterCategory = (typeof RECRUITER_CATEGORIES)[number];

export const RECRUITER_CATEGORY_LABELS: Record<RecruiterCategory, string> = {
  IT: "IT",
  PRODUCT: "Product",
  CORE: "Core engineering",
  CONSULTING: "Consulting",
  STARTUP: "Startup",
  OTHER: "Other",
};

/** PassPercent's own fixed bucket scheme — see the design spec's Decision 4. */
export const GRADE_BUCKETS = ["90+", "80-90", "70-80", "60-70", "50-60", "below50"] as const;
export type GradeBucket = (typeof GRADE_BUCKETS)[number];

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

/**
 * An institution with thirty distinct charges has a different problem than this
 * feature solves.
 */
export const FEE_HEAD_MAX = 30;

export const SCHOLARSHIP_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ScholarshipStatus = (typeof SCHOLARSHIP_STATUSES)[number];

export const SCHOLARSHIP_STATUS_LABELS: Record<ScholarshipStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const OFFER_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const OFFER_KINDS = ["PERCENTAGE", "FLAT"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

export const OFFER_KIND_LABELS: Record<OfferKind, string> = {
  PERCENTAGE: "Percentage off",
  FLAT: "Flat amount off",
};

/** Document-count caps. Neither is enforced by an index — the service checks before insert. */
export const SCHOLARSHIP_MAX_PER_INSTITUTION = 40;
export const OFFER_MAX_PER_INSTITUTION = 40;

export const PLATFORMS = ["PASSPERCENT", "FEESBASKET", "EDUFLEET"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  PASSPERCENT: "PassPercent",
  FEESBASKET: "FeesBasket",
  EDUFLEET: "eduFleet Exchange",
};

/**
 * `"ERROR"` is **legacy-only and is written by nothing** — settled here (M3)
 * rather than left as an open question, because it had already changed
 * behaviour once by being read as a live status.
 *
 * It used to be what a sync wrote when a `ConnectorAuthError` proved the
 * grant dead. That is now `DISCONNECTED` on every path that detects a
 * revocation, and deliberately: `DISCONNECTED` is what spec §9 names, it is
 * the status that re-offers "Request connection", and — unlike `ERROR` — it
 * comes with dropping the ciphertext, so a later poll cannot resurrect the
 * connection from a credential eduFleet has already refused. Giving `ERROR` a
 * writer again would mean one fact producing two states, which is the shape
 * that caused the regression M3 records.
 *
 * It stays in the enum because rows written before that change may hold it,
 * and a value the schema rejects would make those rows unreadable. Readers
 * that still name it (`connections-panel.tsx`) are keeping those rows
 * working, not describing anything new code can produce. Do not add a writer;
 * if a genuinely non-credential failure state is ever needed, give it its own
 * value and its own reason for existing.
 */
export const CONNECTION_STATUSES = [
  "PENDING",
  "AWAITING_APPROVAL",
  "CONNECTED",
  "REJECTED",
  "DISCONNECTED",
  "ERROR",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  PENDING: "Requested",
  AWAITING_APPROVAL: "Awaiting school approval",
  CONNECTED: "Connected",
  REJECTED: "Rejected",
  DISCONNECTED: "Disconnected",
  ERROR: "Needs attention",
};

export const SYNC_STATUSES = ["SUCCESS", "PARTIAL", "FAILED"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** SyncRun rows kept per (institution, platform) — a log, not an archive. */
export const SYNC_RUN_KEEP = 20;

/**
 * A `syncInProgress` lock older than this is treated as abandoned (a crashed
 * process, a killed request) rather than a genuine in-flight sync, and can be
 * reacquired by a new `syncNow` call. Chosen as an order of magnitude above
 * any realistic sync duration: the connector HTTP client caps each call at
 * 15s + one retry, and even a dozen result-year PUTs plus the schema/profile
 * calls stays well under a few minutes.
 */
export const SYNC_LOCK_STALE_MINUTES = 10;

export const ACHIEVEMENT_CATEGORIES = [
  "ACADEMIC", "SPORTS", "CULTURAL", "OLYMPIAD", "SCIENCE_FAIR", "ROBOTICS", "COMMUNITY_SERVICE",
] as const;
export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number];

export const ACHIEVEMENT_CATEGORY_LABELS: Record<AchievementCategory, string> = {
  ACADEMIC: "Academic",
  SPORTS: "Sports",
  CULTURAL: "Cultural",
  OLYMPIAD: "Olympiad",
  SCIENCE_FAIR: "Science Fair",
  ROBOTICS: "Robotics",
  COMMUNITY_SERVICE: "Community Service",
};

export const ACHIEVEMENT_LEVELS = [
  "SCHOOL", "TALUK", "DISTRICT", "STATE", "NATIONAL", "INTERNATIONAL",
] as const;
export type AchievementLevel = (typeof ACHIEVEMENT_LEVELS)[number];

export const ALUMNI_CATEGORIES = [
  "DOCTOR", "ENGINEER", "ENTREPRENEUR", "CIVIL_SERVICES", "SCIENTIST", "ARTIST", "SPORTS", "OTHER",
] as const;
export type AlumniCategory = (typeof ALUMNI_CATEGORIES)[number];

export const ALUMNI_CATEGORY_LABELS: Record<AlumniCategory, string> = {
  DOCTOR: "Doctor",
  ENGINEER: "Engineer",
  ENTREPRENEUR: "Entrepreneur",
  CIVIL_SERVICES: "Civil Services",
  SCIENTIST: "Scientist",
  ARTIST: "Artist",
  SPORTS: "Sports",
  OTHER: "Other",
};

/** Same two-state visibility as media: manageable in the dashboard, HIDDEN never published. */
export const SHOWCASE_STATUSES = ["ACTIVE", "HIDDEN"] as const;
export type ShowcaseStatus = (typeof SHOWCASE_STATUSES)[number];

export const ACHIEVEMENT_MAX_PHOTOS = 10;
export const ACHIEVEMENT_MAX_CERTIFICATES = 5;
export const ACHIEVEMENT_MAX_STUDENTS = 50;

/**
 * How many records one institution may keep, the counterpart to the three
 * per-record caps above — those bound what one achievement holds, these bound
 * how many there are. Same reason `MEDIA_MAX_ITEMS` exists: every list here
 * is fetched whole, and both of these are fetched by
 * `InstitutionService.getPublicProfile` into a single unauthenticated,
 * CORS-open response.
 *
 * 200 each is deliberately far above real use — an achievement a fortnight
 * for eight years, or 200 curated notable alumni on a page whose whole point
 * is that they are notable — while still bounding the public payload
 * (~2 MB of achievements at their absolute worst case of 2000-character
 * descriptions plus 50 students each; ~200 KB of alumni) and keeping
 * `listPublic`'s unindexed sort a top-K sort over a few hundred documents
 * rather than a blocking sort that can pass MongoDB's memory limit and 500
 * the entire public profile.
 */
export const ACHIEVEMENT_MAX_RECORDS = 200;
export const ALUMNI_MAX_RECORDS = 200;

/**
 * There is deliberately no `SHOWCASE_MAX_IMAGE_BYTES` beside this. Showcase
 * images are uploaded through `validateImage` (`src/lib/media/image.ts`), which
 * enforces `MAX_IMAGE_BYTES` — so a showcase-named image constant would
 * advertise a limit nothing imposes, and the next reader would believe it. One
 * name for one limit; import `MAX_IMAGE_BYTES` if you need the number.
 *
 * This one earns its place: PDFs have no shared validator, so
 * `AchievementService.addCertificate` checks this value directly. It happens to
 * equal `MEDIA_MAX_PDF_BYTES` today, and that is a coincidence rather than a
 * contract — a certificate cap and a brochure cap are free to move apart.
 */
export const SHOWCASE_MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * eduFleet's 16 job subjects, transcribed from
 * /Users/automicai/edufleet-exchange/web/src/lib/taxonomy.ts (JOB_CATEGORIES).
 * eduFleet matches these by EXACT string, not fuzzily, so the literal spelling
 * is the contract. Transcribed rather than fetched so creating a vacancy never
 * depends on eduFleet being reachable.
 */
export const VACANCY_SUBJECTS = [
  "Mathematics", "Physics", "Chemistry", "Biology",
  "English", "Kannada", "Hindi", "Social Science",
  "Principal", "Vice Principal", "Coordinator", "Administrator",
  "Accountant", "Clerk", "Driver", "Librarian",
] as const;
export type VacancySubject = (typeof VACANCY_SUBJECTS)[number];

/** eduFleet's subject groups, for grouping the picker. Same source file. */
export const VACANCY_SUBJECT_GROUPS: Array<{ group: string; subjects: VacancySubject[] }> = [
  { group: "Academic", subjects: ["Mathematics", "Physics", "Chemistry", "Biology", "English", "Kannada", "Hindi", "Social Science"] },
  { group: "Administration", subjects: ["Principal", "Vice Principal", "Coordinator", "Administrator"] },
  { group: "Support", subjects: ["Accountant", "Clerk", "Driver", "Librarian"] },
];

/**
 * eduFleet's 11 employee benefits, transcribed from
 * /Users/automicai/edufleet-exchange/web/src/lib/job-facilities.ts.
 * Sent as literal label strings, not codes.
 *
 * eduFleet's sanitizeFacilities() SILENTLY DISCARDS anything not on this list
 * — it is not a validation error and eduFleet never reports it. IDAP therefore
 * validates against this list before any push (spec §5.1).
 */
export const VACANCY_BENEFITS = [
  "Provident Fund (PF)", "ESI (medical insurance)", "Gratuity", "Health insurance",
  "Staff accommodation", "Transport / bus facility", "Free / subsidised meals",
  "Paid leave", "Annual / festival bonus", "Training & development",
  "Maternity benefits",
] as const;
export type VacancyBenefit = (typeof VACANCY_BENEFITS)[number];

/**
 * eduFleet's 31 Karnataka districts, transcribed from
 * /Users/automicai/edufleet-exchange/web/src/lib/karnataka-taxonomy.ts
 * (`KARNATAKA_DISTRICTS`) in that file's exact key order.
 *
 * The third eduFleet vocabulary IDAP transcribes, and the only one whose
 * values a school types rather than picks. `isValidKarnatakaDistrict` is
 * `Object.hasOwn` against these keys — an EXACT, case-sensitive match — and
 * `createPartnerJob` runs it on every Contract One create whose state is
 * Karnataka (a blank state DEFAULTS to Karnataka, so omitting the state opts
 * in rather than out). These are the modern transliterations, which is
 * precisely why the legacy spellings a school still types — `Mysore`,
 * `Belgaum`, `Gulbarga`, `Bijapur`, `Shimoga`, `Tumkur`, `Bellary`,
 * `Bangalore Urban` — every one of them 400s, at a write unit each from the
 * PLATFORM-WIDE pool.
 *
 * Transcribed rather than fetched, same as the two lists above: publishing a
 * vacancy must not depend on eduFleet being reachable, and this list is what
 * lets IDAP decide locally whether a district is safe to send.
 *
 * **Drift is safe here, and that is the point.** A district Karnataka adds
 * after this was written simply fails to resolve, and an unresolved district
 * is omitted with a warning — never a refusal — so the worst a stale list can
 * do is cost that one school its district-based reach until this array is
 * updated. Nothing here can ever block a publish. See
 * `edufleet-vacancy-map.ts`'s `resolveDistrict` for the resolution and
 * `tests/unit/edufleet-districts.test.ts` for the verbatim pin.
 */
export const EDUFLEET_KARNATAKA_DISTRICTS = [
  "Bagalkot", "Ballari", "Belagavi", "Bengaluru Rural", "Bengaluru Urban",
  "Bidar", "Chamarajanagar", "Chikkaballapur", "Chikkamagaluru", "Chitradurga",
  "Dakshina Kannada", "Davanagere", "Dharwad", "Gadag", "Hassan",
  "Haveri", "Kalaburagi", "Kodagu", "Kolar", "Koppal",
  "Mandya", "Mysuru", "Raichur", "Ramanagara", "Shivamogga",
  "Tumakuru", "Udupi", "Uttara Kannada", "Vijayapura", "Vijayanagara",
  "Yadgir",
] as const;
export type EduFleetKarnatakaDistrict = (typeof EDUFLEET_KARNATAKA_DISTRICTS)[number];

/** DRAFT is never pushed to eduFleet. */
export const VACANCY_STATUSES = ["DRAFT", "OPEN", "FILLED", "CLOSED"] as const;
export type VacancyStatus = (typeof VACANCY_STATUSES)[number];

export const VACANCY_TITLE_MAX = 120;
export const VACANCY_DESCRIPTION_MAX = 2000;

/** Per-institution cap on how many vacancies exist at once — bounds the
 *  dashboard list and the eduFleet sync payload, same shape as
 *  `ALUMNI_MAX_RECORDS` / `ACHIEVEMENT_MAX_RECORDS`. Both readers really do
 *  enforce it now (L3): `VacancyService.list` always did, and
 *  `loadSyncVacancies` used to be an unbounded read that only `create`'s
 *  non-atomic count kept small. The sync reader reports it when it truncates,
 *  rather than quietly reconciling a prefix and calling the run a success. */
export const VACANCY_MAX_RECORDS = 200;

/** Which eduFleet contract created a listing. Contract One (platform key)
 *  produces an `aggregated` job the school may later claim; Contract Two
 *  (school grant) produces a `school_posted` job it already owns. */
export const VACANCY_LISTING_CONTRACTS = ["AGGREGATED", "SCHOOL_POSTED"] as const;
export type VacancyListingContract = (typeof VACANCY_LISTING_CONTRACTS)[number];

/**
 * eduFleet's claim states, mirroring `Job.CLAIM_STATUSES` in full.
 *
 * All four are now here. `withdrawn` used to be left out as "eduFleet-only,
 * nothing IDAP calls can return it" — true of the SUCCESS bodies, and beside
 * the point: eduFleet never reports a claim state on a body IDAP can read,
 * because Contract One's PATCH `403`s on `claimed`, `claim_pending` AND
 * `withdrawn` before it can answer, and Contract Two reports no claim state
 * at all. The state is learned from the free `GET /api/partner/jobs` read
 * that follows a `403 claimed` (`edufleet.ts`'s `resolveClaimState`), and
 * that read reports all four — so dropping `withdrawn` there would silently
 * turn "eduFleet took this advert down" into "state unknown".
 *
 * Terminal-ness is the distinction every consumer actually needs, and it does
 * NOT follow the 403: one `reason: "claimed"` covers three states with two
 * different futures. `isTerminalClaim` below is the single spelling of it.
 */
export const VACANCY_CLAIM_STATES = ["unclaimed", "claim_pending", "claimed", "withdrawn"] as const;
export type VacancyClaimState = (typeof VACANCY_CLAIM_STATES)[number];

/**
 * Whether IDAP can ever act on this listing again — the one rule three
 * separate surfaces key off (the delete's close-first exception, the
 * reconciler's skip, and the dashboard card's read-only state), written once
 * so it cannot drift between them.
 *
 * - `claimed` — the advert moved onto the school's OWN eduFleet account.
 *   IDAP's platform key is refused on it permanently, and the school can
 *   edit and close it there. Terminal.
 * - `withdrawn` — an admin-approved takedown removed the listing from public
 *   view. `updatePartnerJob` refuses a partner key on it precisely so a
 *   partner cannot resurrect what admin took down. Terminal, and there is
 *   nothing live left to protect.
 * - `claim_pending` — a claim is awaiting an admin's decision, and a
 *   REJECTED claim returns the job to `unclaimed`. **Not terminal**: IDAP
 *   must still close before deleting, and the reconciler must still retry,
 *   or a rejected claim leaves a live advert IDAP has already stopped
 *   managing.
 * - `unclaimed`/absent — ordinary; nothing to skip.
 */
export function isTerminalClaim(claimState: string | null | undefined): boolean {
  return claimState === "claimed" || claimState === "withdrawn";
}

/**
 * The status eduFleet's own `Job` carries, mirrored verbatim
 * (`models/Job.ts:45` — `enum: ["active", "closed"]`), because IDAP has to
 * know whether the advert a listing points at is still visible to teachers.
 *
 * It is NOT the same thing as the IDAP vacancy's own status. A closed job
 * keeps its `externalJobId` forever — the dedupe pre-check
 * (`partner-jobs.ts:126`, `partner-school-jobs.ts:67`) and the unique index
 * (`models/Job.ts:82-91`) both filter on `{partnerId, partnerExternalJobId}`
 * with no status condition — and neither partner contract can reopen one
 * (Contract Two's PATCH accepts only `"closed"`). So a vacancy that is
 * refilled and published again needs a NEW listing under a NEW
 * `externalJobId`, which is the spec's own decision (§7) and is only
 * possible if IDAP records that the old advert went dark.
 */
export const VACANCY_LISTING_REMOTE_STATUSES = ["active", "closed"] as const;
export type VacancyListingRemoteStatus = (typeof VACANCY_LISTING_REMOTE_STATUSES)[number];
