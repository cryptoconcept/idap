import "server-only";
import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Lead, User, type LeadDoc } from "@/models";
import { generateLeadNumber } from "./sequence.service";
import { ActivityService } from "./activity.service";
import { NotificationService } from "./notification.service";
import { afterResponse } from "@/lib/after-response";
import { notFound, validationError } from "@/lib/api/errors";
import { assertOwnsLead } from "@/lib/tenant/permissions";
import { dateRangeFilter, escapeRegex, requiredIso } from "@/lib/utils/serialize";
import type { LeadDTO, Paginated } from "@/lib/types";
import type { LeadStatus, Source } from "@/lib/constants";
import type { CreateLeadInput, LeadQuery } from "@/lib/validation/lead";
import type { CurrentUser } from "@/lib/auth/current-user";

type LeadRow = LeadDoc & { _id: Types.ObjectId };

function serialize(row: LeadRow, assigneeNames?: Map<string, string>): LeadDTO {
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
    assignedTo: row.assignedTo ?? undefined,
    assignedToName: row.assignedTo ? assigneeNames?.get(row.assignedTo) : undefined,
    assignedAt: row.assignedAt ? requiredIso(row.assignedAt) : undefined,
    followUpAt: row.followUpAt ? requiredIso(row.followUpAt) : undefined,
    followUpNotifiedAt: row.followUpNotifiedAt ? requiredIso(row.followUpNotifiedAt) : undefined,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

/** Batch-resolves assignee names for a set of leads in one query, not N+1. */
async function resolveAssigneeNames(rows: LeadRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.assignedTo).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();

  const users = await User.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(users.map((user) => [String(user._id), user.name]));
}

/** Resolves institution names in one round trip for cross-tenant admin lists. */

function buildFilter(
  tenantClause: Record<string, unknown>,
  query: Partial<LeadQuery>,
): FilterQuery<LeadDoc> {
  const filter: FilterQuery<LeadDoc> = { ...tenantClause };
  // The tenant clause can carry its own $or — leadVisibilityFilter's "mine plus
  // unassigned" scoping. Assigning the search $or straight onto the filter would
  // overwrite that key and silently drop the scoping, so both clauses go under
  // $and and have to hold together.
  const and: FilterQuery<LeadDoc>[] = [];

  if (filter.$or) {
    and.push({ $or: filter.$or as FilterQuery<LeadDoc>[] });
    delete filter.$or;
  }

  if (query.status) filter.status = query.status;
  if (query.source) filter.source = query.source;

  const createdAt = dateRangeFilter(query.from, query.to);
  if (createdAt) filter.createdAt = createdAt;

  if (query.q) {
    // Escaped so a search string can never be interpreted as a regex or operator.
    const pattern = new RegExp(escapeRegex(query.q), "i");
    and.push({
      $or: [
        { leadNumber: pattern },
        { studentName: pattern },
        { parentName: pattern },
        { phone: pattern },
        { email: pattern },
      ],
    });
  }

  if (and.length > 0) filter.$and = and;

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

    const assigneeNames = await resolveAssigneeNames(rows as LeadRow[]);

    return {
      items: rows.map((row) => serialize(row as LeadRow, assigneeNames)),
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

    const assigneeNames = await resolveAssigneeNames([row as LeadRow]);
    return serialize(row as LeadRow, assigneeNames);
  },

  async updateStatus(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    status: LeadStatus;
    user: CurrentUser;
  }): Promise<LeadDTO> {
    await connectToDatabase();
    const existing = await LeadService.getById(input.tenantClause, input.id);
    assertOwnsLead(input.user, { assignedTo: existing.assignedTo ?? null });
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
      performedBy: input.user.id,
      performedByName: input.user.name,
    });

    return serialize(updated as LeadRow);
  },

  async assign(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    assignedTo: string | null;
    actor: { id: string; name: string };
  }): Promise<LeadDTO> {
    await connectToDatabase();
    const existing = await LeadService.getById(input.tenantClause, input.id);

    let targetName: string | undefined;
    if (input.assignedTo) {
      const target = await User.findOne({
        _id: input.assignedTo,
        institutionId: existing.institutionId,
      })
        .select("role name")
        .lean();
      if (!target) throw notFound("Enquiry not found");
      if (target.role !== "INSTITUTION_ADMIN" && target.role !== "COUNSELOR") {
        throw validationError("assignedTo: must be a counselor or admin at this institution");
      }
      targetName = target.name;
    }

    const previousAssignee = existing.assignedTo;
    const updated = await Lead.findOneAndUpdate(
      { _id: new Types.ObjectId(existing.id), ...input.tenantClause },
      input.assignedTo
        ? { $set: { assignedTo: input.assignedTo, assignedAt: new Date() } }
        : { $unset: { assignedTo: "", assignedAt: "" } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Enquiry not found");

    const action = !previousAssignee
      ? "Lead assigned"
      : !input.assignedTo
        ? "Lead unassigned"
        : "Lead reassigned";
    await ActivityService.record({
      institutionId: updated.institutionId,
      entityType: "LEAD",
      entityId: updated._id,
      entityRef: updated.leadNumber,
      action,
      description: input.assignedTo
        ? `Assigned to ${targetName}`
        : "Unassigned",
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    const assigneeNames =
      input.assignedTo && targetName ? new Map([[input.assignedTo, targetName]]) : undefined;
    return serialize(updated as LeadRow, assigneeNames);
  },

  async setFollowUp(input: {
    tenantClause: Record<string, unknown>;
    id: string;
    followUpAt: string | null;
    user: CurrentUser;
  }): Promise<LeadDTO> {
    await connectToDatabase();
    const existing = await LeadService.getById(input.tenantClause, input.id);
    assertOwnsLead(input.user, { assignedTo: existing.assignedTo ?? null });

    // followUpNotifiedAt is always $unset, never $set — a field cannot appear in
    // both operators on the same update, and $unset alone is what re-arms the
    // reminder (Global Constraint: "followUpNotifiedAt is cleared whenever
    // followUpAt changes").
    const update = input.followUpAt
      ? { $set: { followUpAt: new Date(input.followUpAt) }, $unset: { followUpNotifiedAt: "" } }
      : { $unset: { followUpAt: "", followUpNotifiedAt: "" } };

    const updated = await Lead.findOneAndUpdate(
      { _id: new Types.ObjectId(existing.id), ...input.tenantClause },
      update,
      { new: true },
    ).lean();
    if (!updated) throw notFound("Enquiry not found");

    await ActivityService.record({
      institutionId: updated.institutionId,
      entityType: "LEAD",
      entityId: updated._id,
      entityRef: updated.leadNumber,
      action: input.followUpAt ? "Follow-up date set" : "Follow-up date cleared",
      performedBy: input.user.id,
      performedByName: input.user.name,
    });

    const assigneeNames =
      existing.assignedTo && existing.assignedToName
        ? new Map([[existing.assignedTo, existing.assignedToName]])
        : undefined;
    return serialize(updated as LeadRow, assigneeNames);
  },

  async recent(tenantClause: Record<string, unknown>, limit = 5): Promise<LeadDTO[]> {
    await connectToDatabase();
    const rows = await Lead.find(tenantClause).sort({ createdAt: -1 }).limit(limit).lean();
    return rows.map((row) => serialize(row as LeadRow));
  },

  async listAssignees(institutionId: string): Promise<{ id: string; name: string }[]> {
    await connectToDatabase();
    const rows = await User.find({
      institutionId,
      role: { $in: ["INSTITUTION_ADMIN", "COUNSELOR"] },
      active: true,
    })
      .select("name")
      .sort({ name: 1 })
      .lean();
    return rows.map((row) => ({ id: String(row._id), name: row.name }));
  },
};
