import { z } from "zod";
import { HUB_APPLICATION_STATUSES, SCHOLARSHIP_APPLICATION_REVIEW_STATUSES } from "@/lib/constants";

export const scholarshipApplicationQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  hubStatus: z.enum(HUB_APPLICATION_STATUSES).optional(),
  reviewStatus: z.enum(SCHOLARSHIP_APPLICATION_REVIEW_STATUSES).optional(),
  assignedTo: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ScholarshipApplicationQuery = z.infer<typeof scholarshipApplicationQuerySchema>;

export const updateScholarshipApplicationReviewStatusSchema = z.object({
  reviewStatus: z.enum(SCHOLARSHIP_APPLICATION_REVIEW_STATUSES),
});

export const assignScholarshipApplicationSchema = z.object({
  assignedTo: z.string().min(1).nullable(),
});
