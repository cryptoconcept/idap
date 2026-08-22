import "server-only";
import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Lead, type LeadDoc } from "@/models";
import { generateLeadNumber } from "./sequence.service";
import { ActivityService } from "./activity.service";
import { NotificationService } from "./notification.service";
import { afterResponse } from "@/lib/after-response";
import { notFound } from "@/lib/api/errors";
import { dateRangeFilter, escapeRegex, requiredIso } from "@/lib/utils/serialize";
import type { LeadDTO, Paginated } from "@/lib/types";
import type { LeadStatus, Source } from "@/lib/constants";
import type { CreateLeadInput, LeadQuery } from "@/lib/validation/lead";

type LeadRow = LeadDoc & { _id: Types.ObjectId };

function serialize(row: LeadRow): LeadDTO {
  return {
    id: String(row._id),
    leadNumber: row.leadNumber,
    institutionId: row.institutionId,
    studentName: row.studentName,
    parentName: row.parentName ?? undefined,
    phone: row.phone,
    email: row.email ?? undefined,
    classInterested: row.classInterested ?? undefined,
    message: row.message ?? undefined,
    status: row.status as LeadStatus,
    source: row.source as Source,
    sourceApplication: row.sourceApplication ?? undefined,
    sourceUrl: row.sourceUrl ?? undefined,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

/** Resolves institution names in one round trip for cross-tenant admin lists. */

function buildFilter(
  tenantClause: Record<string, unknown>,
  query: Partial<LeadQuery>,
): FilterQuery<LeadDoc> {
  const filter: FilterQuery<LeadDoc> = { ...tenantClause };

  if (query.status) filter.status = query.status;
  if (query.source) filter.source = query.source;

  const createdAt = dateRangeFilter(query.from, query.to);
  if (createdAt) filter.createdAt = createdAt;

  if (query.q) {
    // Escaped so a search string can never be interpreted as a regex or operator.
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [
      { leadNumber: pattern },
      { studentName: pattern },
      { parentName: pattern },
      { phone: pattern },
      { email: pattern },
    ];
  }

  return filter;
}

export const LeadService = {
  async createLead(input: {
    institutionId: string;
    data: CreateLeadInput;
    source: Source;
    actor?: { id?: string; name?: string };
    ipAddress?: string;
  }): Promise<LeadDTO> {
    await connectToDatabase();
    const leadNumber = await generateLeadNumber(input.institutionId);

    const created = await Lead.create({
      leadNumber,
      institutionId: input.institutionId,
      studentName: input.data.studentName,
      parentName: input.data.parentName,
      phone: input.data.phone,
      email: input.data.email,
      classInterested: input.data.classInterested,
      message: input.data.message,
      status: "NEW",
      source: input.source,
      sourceApplication: input.data.sourceApplication,
      sourceUrl: input.data.sourceUrl,
    });

    await ActivityService.record({
      institutionId: input.institutionId,
      entityType: "LEAD",
      entityId: created._id,
      entityRef: leadNumber,
      action: "Enquiry received",
      description: `Enquiry ${leadNumber} received via ${input.source.toLowerCase()}`,
      performedBy: input.actor?.id,
      performedByName: input.actor?.name,
      ipAddress: input.ipAddress,
    });

    // Deferred rather than fire-and-forget. The audit write above is awaited
    // and swallows its own failures; a floating promise here would instead be
    // abandoned the moment the handler returns, and on Vercel may never run at
    // all. `afterResponse` hands it to the platform to finish after the
    // response, and the catch keeps a push failure away from the submission.
    await afterResponse(() =>
      NotificationService.notifyNewLead({
        institutionId: input.institutionId,
        leadNumber,
        studentName: input.data.studentName,
        classInterested: input.data.classInterested,
      }).catch((error) => console.error("[push] enquiry notification failed", error)),
    );

    return serialize(created.toObject() as LeadRow);
  },

  async list(
    tenantClause: Record<string, unknown>,
    query: Partial<LeadQuery>,
  ): Promise<Paginated<LeadDTO>> {
    await connectToDatabase();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const filter = buildFilter(tenantClause, query);

    const [rows, total] = await Promise.all([
      Lead.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Lead.countDocuments(filter),
    ]);

    return {
      items: rows.map((row) => serialize(row as LeadRow)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  },

  async getById(tenantClause: Record<string, unknown>, id: string): Promise<LeadDTO> {
    await connectToDatabase();
    const filter: FilterQuery<LeadDoc> = { ...tenantClause };
    if (Types.ObjectId.isValid(id)) {
      filter._id = new Types.ObjectId(id);
    } else {
      filter.leadNumber = id;
    }

    const row = await Lead.findOne(filter).lean();
    if (!row) throw notFound("Enquiry not found");

    return serialize(row as LeadRow);
  },

  async updateStatus(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    status: LeadStatus;
    actor: { id: string; name: string };
  }): Promise<LeadDTO> {
    await connectToDatabase();
    const existing = await LeadService.getById(input.tenantClause, input.id);
    if (existing.status === input.status) return existing;

    const updated = await Lead.findOneAndUpdate(
      { _id: new Types.ObjectId(existing.id), ...input.tenantClause },
      { $set: { status: input.status } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Enquiry not found");

    await ActivityService.record({
      institutionId: updated.institutionId,
      entityType: "LEAD",
      entityId: updated._id,
      entityRef: updated.leadNumber,
      action: `Status changed to ${input.status}`,
      description: `Status changed from ${existing.status} to ${input.status}`,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return serialize(updated as LeadRow);
  },

  async recent(tenantClause: Record<string, unknown>, limit = 5): Promise<LeadDTO[]> {
    await connectToDatabase();
    const rows = await Lead.find(tenantClause).sort({ createdAt: -1 }).limit(limit).lean();
    return rows.map((row) => serialize(row as LeadRow));
  },
};
