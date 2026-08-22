import type {
  ApplicationStatus,
  ApiPermission,
  DocumentType,
  InstitutionType,
  LeadStatus,
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
};
