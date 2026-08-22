import { z } from "zod";
import { INSTITUTION_TYPES } from "@/lib/constants";
import {
  optionalEmailSchema,
  optionalPhoneSchema,
  optionalPincodeSchema,
  optionalText,
  optionalUrlSchema,
  requiredText,
} from "./common";

const brandingFields = {
  address: optionalText(300),
  city: optionalText(80),
  state: optionalText(80),
  pincode: optionalPincodeSchema,
  contactPerson: optionalText(120),
  phone: optionalPhoneSchema,
  email: optionalEmailSchema,
  website: optionalUrlSchema,
  logoUrl: optionalUrlSchema,
};

export const createInstitutionSchema = z.object({
  institutionId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^INS\d{4,6}$/, "Institution ID must look like INS0001")
    .optional(),
  institutionName: requiredText("Institution name", 160),
  institutionType: z.enum(INSTITUTION_TYPES),
  ...brandingFields,
  // Optional bootstrap admin created alongside the institution.
  adminName: optionalText(120),
  adminEmail: optionalEmailSchema,
  adminPassword: z.string().min(10, "Password must be at least 10 characters").max(128).optional(),
});

export const updateInstitutionSchema = z.object({
  institutionName: requiredText("Institution name", 160).optional(),
  institutionType: z.enum(INSTITUTION_TYPES).optional(),
  ...brandingFields,
  active: z.boolean().optional(),
});

/** Fields an institution admin may change on their own profile. */
export const updateInstitutionProfileSchema = z.object({
  institutionName: requiredText("Institution name", 160).optional(),
  ...brandingFields,
});
