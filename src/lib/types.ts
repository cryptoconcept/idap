import type {
  ApplicationStatus,
  ApiPermission,
  DocumentType,
  GalleryStatus,
  GenderType,
  InstitutionType,
  LeadStatus,
  ManagementType,
  ProfileStatus,
  Source,
  UserRole,
} from "@/lib/constants";

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type LeadDTO = {
  id: string;
  leadNumber: string;
  institutionId: string;
  studentName: string;
  parentName?: string;
  phone: string;
  email?: string;
  classInterested?: string;
  message?: string;
  status: LeadStatus;
  source: Source;
  sourceApplication?: string;
  sourceUrl?: string;
  assignedTo?: string;
  assignedToName?: string;
  assignedAt?: string;
  followUpAt?: string;
  followUpNotifiedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ApplicationDocumentDTO = {
  id: string;
  documentType: DocumentType;
  fileName: string;
  fileUrl: string;
  uploadedAt: string;
};

export type ApplicationDTO = {
  id: string;
  applicationNumber: string;
  institutionId: string;
  academicYear: string;
  student: {
    firstName: string;
    middleName?: string;
    lastName?: string;
    fullName: string;
    dateOfBirth?: string;
    gender?: string;
    bloodGroup?: string;
  };
  parent: {
    fatherName?: string;
    motherName?: string;
    guardianName?: string;
    phone: string;
    alternatePhone?: string;
    email?: string;
  };
  address: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    pincode?: string;
  };
  academic: {
    previousInstitution?: string;
    previousClass?: string;
    previousPercentage?: number;
  };
  admission: {
    applyingFor: string;
    admissionType?: string;
  };
  message?: string;
  documents: ApplicationDocumentDTO[];
  status: ApplicationStatus;
  source: Source;
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type InstitutionDTO = {
  id: string;
  institutionId: string;
  institutionName: string;
  institutionType: InstitutionType;
  /** Display-only geography code (e.g. "KA-MYS"). Platform-admin-owned provisioning metadata. */
  regionCode?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  website?: string;
  logoUrl?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/** The full profile surface — everything `InstitutionDTO` has, plus every profile section. */
export type ProfileDTO = InstitutionDTO & {
  slug?: string;
  legalName?: string;
  shortName?: string;
  coverImageUrl?: string;
  establishedYear?: number;
  tagline?: string;
  description?: string;
  profileStatus: ProfileStatus;
  /** Set once, on first publish. Unpublishing never clears it — history, not state. */
  publishedAt?: string;

  addressLine2?: string;
  locality?: string;
  area?: string;
  taluk?: string;
  district?: string;
  country?: string;

  contact?: {
    secondaryPhone?: string;
    alternateEmail?: string;
    whatsapp?: string;
  };
  geo?: {
    latitude?: number;
    longitude?: number;
    mapUrl?: string;
  };
  academic?: {
    board?: string;
    affiliation?: string;
    recognition?: string;
    affiliationNumber?: string;
    udiseCode?: string;
    medium?: string[];
    genderType?: GenderType;
    currentAcademicYear?: string;
    classesOffered?: string[];
    coursesOffered?: string[];
  };
  management?: {
    managementType?: ManagementType;
    trustName?: string;
    societyName?: string;
    managementName?: string;
    principalName?: string;
    headDesignation?: string;
    headEmail?: string;
    headPhone?: string;
  };
  facilities?: {
    code: string;
    label: string;
    available?: boolean;
    note?: string;
  }[];
  feeHeads?: { label: string; amount?: number; frequency?: string }[];
  social?: {
    facebook?: string;
    instagram?: string;
    youtube?: string;
    linkedin?: string;
    x?: string;
    other?: { label: string; url?: string }[];
  };
  gallery?: {
    id: string;
    imageUrl: string;
    title?: string;
    description?: string;
    sortOrder: number;
    status: GalleryStatus;
    uploadedAt: string;
  }[];
};

export type ApiClientDTO = {
  id: string;
  institutionId: string;
  institutionName?: string;
  name: string;
  keyId: string;
  active: boolean;
  permissions: ApiPermission[];
  lastUsedAt?: string;
  requestCount: number;
  createdAt: string;
  revokedAt?: string;
};

export type SessionUserDTO = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  institutionId?: string;
};

export type DashboardStats = {
  totalEnquiries: number;
  newEnquiries: number;
  totalApplications: number;
  underReview: number;
  approved: number;
  admitted: number;
  profile: { status: ProfileStatus; completionPercent: number };
  integration: { activeCredentials: number; lastUsedAt?: string };
};
