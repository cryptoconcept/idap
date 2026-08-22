import { z } from "zod";
import { APPLICATION_STATUSES, DOCUMENT_TYPES, SOURCES } from "@/lib/constants";
import {
  academicYearSchema,
  optionalDateSchema,
  optionalEmailSchema,
  optionalPhoneSchema,
  optionalPincodeSchema,
  optionalText,
  optionalUrlSchema,
  phoneSchema,
  requiredText,
} from "./common";

const documentSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  fileName: requiredText("File name", 200),
  fileUrl: z.string().trim().max(1000),
});

/**
 * Whitelisted application payload. Unknown keys are dropped by Zod's default
 * object behaviour, which is what protects the models from mass assignment.
 */
export const createApplicationSchema = z.object({
  academicYear: academicYearSchema,
  student: z.object({
    firstName: requiredText("Student first name", 80),
    middleName: optionalText(80),
    lastName: optionalText(80),
    dateOfBirth: optionalDateSchema,
    gender: optionalText(20),
    bloodGroup: optionalText(10),
  }),
  parent: z.object({
    fatherName: optionalText(120),
    motherName: optionalText(120),
    guardianName: optionalText(120),
    phone: phoneSchema,
    alternatePhone: optionalPhoneSchema,
    email: optionalEmailSchema,
  }),
  address: z
    .object({
      addressLine1: optionalText(200),
      addressLine2: optionalText(200),
      city: optionalText(80),
      state: optionalText(80),
      pincode: optionalPincodeSchema,
    })
    .optional()
    .default({}),
  academic: z
    .object({
      previousInstitution: optionalText(160),
      previousClass: optionalText(80),
      previousPercentage: z.coerce.number().min(0).max(100).optional(),
    })
    .optional()
    .default({}),
  admission: z.object({
    applyingFor: requiredText("Applying for", 80),
    admissionType: optionalText(40),
  }),
  message: optionalText(2000),
  documents: z.array(documentSchema).max(20).optional().default([]),
  sourceUrl: optionalUrlSchema,
});
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export const updateApplicationStatusSchema = z.object({
  status: z.enum(APPLICATION_STATUSES),
  note: optionalText(1000),
});

export const applicationQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  source: z.enum(SOURCES).optional(),
  academicYear: z.string().trim().max(20).optional(),
  applyingFor: z.string().trim().max(80).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ApplicationQuery = z.infer<typeof applicationQuerySchema>;
