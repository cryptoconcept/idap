import { z } from "zod";
import { LEAD_STATUSES, SOURCES } from "@/lib/constants";
import {
  optionalEmailSchema,
  optionalText,
  optionalUrlSchema,
  phoneSchema,
  requiredText,
} from "./common";

/**
 * Payload accepted from external API clients and the hosted enquiry form.
 * `institutionId` is deliberately absent — the tenant comes from the credential.
 */
export const createLeadSchema = z.object({
  studentName: requiredText("Student name", 120),
  parentName: optionalText(120),
  phone: phoneSchema,
  email: optionalEmailSchema,
  classInterested: optionalText(80),
  message: optionalText(2000),
  sourceApplication: optionalText(80),
  sourceUrl: optionalUrlSchema,
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    classInterested: optionalText(80),
    parentName: optionalText(120),
    email: optionalEmailSchema,
    followUpAt: z.string().trim().nullable().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Nothing to update",
  });

export const assignLeadSchema = z.object({
  assignedTo: z.string().min(1).nullable(),
});
export type AssignLeadInput = z.infer<typeof assignLeadSchema>;

export const leadQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  source: z.enum(SOURCES).optional(),
  assignedTo: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type LeadQuery = z.infer<typeof leadQuerySchema>;
