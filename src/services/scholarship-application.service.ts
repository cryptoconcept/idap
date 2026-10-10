import "server-only";
import { Types, type FilterQuery } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { ScholarshipApplication } from "@/models";
import type { ScholarshipApplicationDoc } from "@/models";
import { ActivityService } from "./activity.service";
import { notFound } from "@/lib/api/errors";
import type { ScholarshipApplicationQuery } from "@/lib/validation/scholarship-application";
import type { HubApplicationStatus, ScholarshipApplicationReviewStatus } from "@/lib/constants";
import { escapeRegex } from "@/lib/utils/serialize";

export type ScholarshipApplicationDTO = {
  id: string;
  scholarshipId: string;
  externalRef: string;
  hubApplicationId: string;
  applicationNo?: string;
  applicant: { name: string; email?: string; mobile?: string };
  answers: Record<string, unknown>;
  documents: { key: string; label: string; filename: string; contentType: string }[];
  hubStatus: HubApplicationStatus;
  reviewStatus: ScholarshipApplicationReviewStatus;
  assignedTo?: string;
  assignedAt?: string;
  submittedAt?: string;
  withdrawnAt?: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number; totalPages: number };

function serialize(doc: ScholarshipApplicationDoc): ScholarshipApplicationDTO {
  return {
    id: String(doc._id),
    scholarshipId: String(doc.scholarshipId),
    externalRef: doc.externalRef,
    hubApplicationId: doc.hubApplicationId,
    ...(doc.applicationNo != null ? { applicationNo: doc.applicationNo } : {}),
    applicant: { name: doc.applicant.name, ...(doc.applicant.email ? { email: doc.applicant.email } : {}), ...(doc.applicant.mobile ? { mobile: doc.applicant.mobile } : {}) },
    answers: (doc.answers ?? {}) as Record<string, unknown>,
    documents: (doc.documents ?? []).map((d) => ({ key: d.key, label: d.label, filename: d.filename, contentType: d.contentType })),
    hubStatus: doc.hubStatus as HubApplicationStatus,
    reviewStatus: doc.reviewStatus as ScholarshipApplicationReviewStatus,
    ...(doc.assignedTo ? { assignedTo: doc.assignedTo } : {}),
    ...(doc.assignedAt ? { assignedAt: new Date(doc.assignedAt).toISOString() } : {}),
    ...(doc.submittedAt ? { submittedAt: new Date(doc.submittedAt).toISOString() } : {}),
    ...(doc.withdrawnAt ? { withdrawnAt: new Date(doc.withdrawnAt).toISOString() } : {}),
    lastSyncedAt: new Date(doc.lastSyncedAt).toISOString(),
    createdAt: new Date((doc as unknown as { createdAt: Date }).createdAt).toISOString(),
    updatedAt: new Date((doc as unknown as { updatedAt: Date }).updatedAt).toISOString(),
  };
}

function buildFilter(
  tenantClause: Record<string, unknown>,
  query: Partial<ScholarshipApplicationQuery>,
): FilterQuery<ScholarshipApplicationDoc> {
  const filter: FilterQuery<ScholarshipApplicationDoc> = { ...tenantClause };
  if (query.hubStatus) filter.hubStatus = query.hubStatus;
  if (query.reviewStatus) filter.reviewStatus = query.reviewStatus;
  if (query.assignedTo) filter.assignedTo = query.assignedTo;
  if (query.q) filter["applicant.name"] = { $regex: `^${escapeRegex(query.q.trim())}`, $options: "i" };
  if (query.from || query.to) {
    filter.createdAt = {
      ...(query.from ? { $gte: new Date(query.from) } : {}),
      ...(query.to ? { $lte: new Date(query.to) } : {}),
    };
  }
  return filter;
}

export const ScholarshipApplicationService = {
  async list(
    tenantClause: Record<string, unknown>,
    query: Partial<ScholarshipApplicationQuery>,
  ): Promise<Paginated<ScholarshipApplicationDTO>> {
    await connectToDatabase();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const filter = buildFilter(tenantClause, query);

    const [rows, total] = await Promise.all([
      ScholarshipApplication.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      ScholarshipApplication.countDocuments(filter),
    ]);

    return {
      items: rows.map((row) => serialize(row as ScholarshipApplicationDoc)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  },

  async get(tenantClause: Record<string, unknown>, id: string): Promise<ScholarshipApplicationDTO> {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(id)) throw notFound("Scholarship application not found");
    const row = await ScholarshipApplication.findOne({ _id: id, ...tenantClause }).lean();
    if (!row) throw notFound("Scholarship application not found");
    return serialize(row as ScholarshipApplicationDoc);
  },

  async assign(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    assignedTo: string | null;
    actor: { id?: string; name?: string };
  }): Promise<ScholarshipApplicationDTO> {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(input.id)) throw notFound("Scholarship application not found");
    const updated = await ScholarshipApplication.findOneAndUpdate(
      { _id: input.id, ...input.tenantClause },
      input.assignedTo
        ? { $set: { assignedTo: input.assignedTo, assignedAt: new Date() } }
        : { $unset: { assignedTo: "", assignedAt: "" } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Scholarship application not found");

    await ActivityService.record({
      institutionId: String((updated as ScholarshipApplicationDoc).institutionId),
      entityType: "SCHOLARSHIP_APPLICATION",
      entityId: (updated as ScholarshipApplicationDoc)._id,
      action: input.assignedTo ? "Scholarship application assigned" : "Scholarship application unassigned",
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return serialize(updated as ScholarshipApplicationDoc);
  },

  async updateReviewStatus(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    reviewStatus: ScholarshipApplicationReviewStatus;
    actor: { id?: string; name?: string };
  }): Promise<ScholarshipApplicationDTO> {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(input.id)) throw notFound("Scholarship application not found");
    const updated = await ScholarshipApplication.findOneAndUpdate(
      { _id: input.id, ...input.tenantClause },
      { $set: { reviewStatus: input.reviewStatus } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Scholarship application not found");

    await ActivityService.record({
      institutionId: String((updated as ScholarshipApplicationDoc).institutionId),
      entityType: "SCHOLARSHIP_APPLICATION",
      entityId: (updated as ScholarshipApplicationDoc)._id,
      action: `Review status changed to ${input.reviewStatus}`,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return serialize(updated as ScholarshipApplicationDoc);
  },
};
