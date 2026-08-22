import "server-only";
import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Application, type ApplicationDoc } from "@/models";
import { generateApplicationNumber } from "./sequence.service";
import { ActivityService } from "./activity.service";
import { notFound } from "@/lib/api/errors";
import { dateRangeFilter, escapeRegex, requiredIso, toIso } from "@/lib/utils/serialize";
import type { ApplicationDTO, Paginated } from "@/lib/types";
import type { ApplicationStatus, DocumentType, Source } from "@/lib/constants";
import type { ApplicationQuery, CreateApplicationInput } from "@/lib/validation/application";

type ApplicationRow = ApplicationDoc & { _id: Types.ObjectId };

export function studentFullName(student: {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
}): string {
  return [student.firstName, student.middleName, student.lastName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ");
}

function serialize(row: ApplicationRow): ApplicationDTO {
  const student = row.student ?? { firstName: "" };
  return {
    id: String(row._id),
    applicationNumber: row.applicationNumber,
    institutionId: row.institutionId,
    academicYear: row.academicYear,
    student: {
      firstName: student.firstName ?? "",
      middleName: student.middleName ?? undefined,
      lastName: student.lastName ?? undefined,
      fullName: row.studentFullName || studentFullName(student),
      dateOfBirth: toIso(student.dateOfBirth),
      gender: student.gender ?? undefined,
      bloodGroup: student.bloodGroup ?? undefined,
    },
    parent: {
      fatherName: row.parent?.fatherName ?? undefined,
      motherName: row.parent?.motherName ?? undefined,
      guardianName: row.parent?.guardianName ?? undefined,
      phone: row.parent?.phone ?? "",
      alternatePhone: row.parent?.alternatePhone ?? undefined,
      email: row.parent?.email ?? undefined,
    },
    address: {
      addressLine1: row.address?.addressLine1 ?? undefined,
      addressLine2: row.address?.addressLine2 ?? undefined,
      city: row.address?.city ?? undefined,
      state: row.address?.state ?? undefined,
      pincode: row.address?.pincode ?? undefined,
    },
    academic: {
      previousInstitution: row.academic?.previousInstitution ?? undefined,
      previousClass: row.academic?.previousClass ?? undefined,
      previousPercentage: row.academic?.previousPercentage ?? undefined,
    },
    admission: {
      applyingFor: row.admission?.applyingFor ?? "",
      admissionType: row.admission?.admissionType ?? undefined,
    },
    message: row.message ?? undefined,
    documents: (row.documents ?? []).map((doc) => ({
      id: String((doc as { _id?: Types.ObjectId })._id ?? ""),
      documentType: doc.documentType as DocumentType,
      fileName: doc.fileName,
      fileUrl: doc.fileUrl,
      uploadedAt: requiredIso(doc.uploadedAt),
    })),
    status: row.status as ApplicationStatus,
    source: row.source as Source,
    sourceUrl: row.sourceUrl ?? undefined,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}


function buildFilter(
  tenantClause: Record<string, unknown>,
  query: Partial<ApplicationQuery>,
): FilterQuery<ApplicationDoc> {
  const filter: FilterQuery<ApplicationDoc> = { ...tenantClause };

  if (query.status) filter.status = query.status;
  if (query.source) filter.source = query.source;
  if (query.academicYear) filter.academicYear = query.academicYear;
  if (query.applyingFor) filter["admission.applyingFor"] = query.applyingFor;

  const createdAt = dateRangeFilter(query.from, query.to);
  if (createdAt) filter.createdAt = createdAt;

  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [
      { applicationNumber: pattern },
      { studentFullName: pattern },
      { "student.firstName": pattern },
      { "student.lastName": pattern },
      { "parent.fatherName": pattern },
      { "parent.motherName": pattern },
      { "parent.guardianName": pattern },
      { "parent.phone": pattern },
      { "parent.email": pattern },
    ];
  }

  return filter;
}

export const ApplicationService = {
  generateApplicationNumber,

  async createApplication(input: {
    institutionId: string;
    data: CreateApplicationInput;
    source: Source;
    actor?: { id?: string; name?: string };
    ipAddress?: string;
  }): Promise<ApplicationDTO> {
    await connectToDatabase();
    const applicationNumber = await generateApplicationNumber(input.institutionId);
    const { data } = input;

    const created = await Application.create({
      applicationNumber,
      institutionId: input.institutionId,
      academicYear: data.academicYear,
      student: data.student,
      studentFullName: studentFullName(data.student),
      parent: data.parent,
      address: data.address ?? {},
      academic: data.academic ?? {},
      admission: data.admission,
      message: data.message,
      documents: (data.documents ?? []).map((doc) => ({ ...doc, uploadedAt: new Date() })),
      status: "SUBMITTED",
      source: input.source,
      sourceUrl: data.sourceUrl,
    });

    await ActivityService.record({
      institutionId: input.institutionId,
      entityType: "APPLICATION",
      entityId: created._id,
      entityRef: applicationNumber,
      action: "Application submitted",
      description: `Application ${applicationNumber} submitted via ${input.source.toLowerCase()}`,
      performedBy: input.actor?.id,
      performedByName: input.actor?.name,
      ipAddress: input.ipAddress,
    });

    return serialize(created.toObject() as ApplicationRow);
  },

  async list(
    tenantClause: Record<string, unknown>,
    query: Partial<ApplicationQuery>,
  ): Promise<Paginated<ApplicationDTO>> {
    await connectToDatabase();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const filter = buildFilter(tenantClause, query);

    const [rows, total] = await Promise.all([
      Application.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Application.countDocuments(filter),
    ]);

    return {
      items: rows.map((row) => serialize(row as ApplicationRow)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  },

  /** Accepts an application number (`INS0001-APP-000124`) or a Mongo id. */
  async getApplication(
    tenantClause: Record<string, unknown>,
    identifier: string,
  ): Promise<ApplicationDTO> {
    await connectToDatabase();
    const filter: FilterQuery<ApplicationDoc> = { ...tenantClause };
    if (Types.ObjectId.isValid(identifier) && !identifier.includes("-")) {
      filter._id = new Types.ObjectId(identifier);
    } else {
      filter.applicationNumber = identifier.toUpperCase();
    }

    const row = await Application.findOne(filter).lean();
    if (!row) throw notFound("Application not found");

    return serialize(row as ApplicationRow);
  },

  async updateStatus(input: {
    tenantClause: Record<string, unknown>;
    identifier: string;
    status: ApplicationStatus;
    actor: { id: string; name: string };
  }): Promise<ApplicationDTO> {
    await connectToDatabase();
    const existing = await ApplicationService.getApplication(input.tenantClause, input.identifier);
    if (existing.status === input.status) return existing;

    const updated = await Application.findOneAndUpdate(
      { _id: new Types.ObjectId(existing.id), ...input.tenantClause },
      { $set: { status: input.status } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Application not found");

    await ActivityService.record({
      institutionId: updated.institutionId,
      entityType: "APPLICATION",
      entityId: updated._id,
      entityRef: updated.applicationNumber,
      action: `Status changed to ${input.status}`,
      description: `Status changed from ${existing.status} to ${input.status}`,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
    });

    return serialize(updated as ApplicationRow);
  },

  async recent(tenantClause: Record<string, unknown>, limit = 5): Promise<ApplicationDTO[]> {
    await connectToDatabase();
    const rows = await Application.find(tenantClause).sort({ createdAt: -1 }).limit(limit).lean();
    return rows.map((row) => serialize(row as ApplicationRow));
  },

  /** Distinct values used to populate the Applications page filter dropdowns. */
  async filterOptions(tenantClause: Record<string, unknown>) {
    await connectToDatabase();
    const [academicYears, classes] = await Promise.all([
      Application.distinct("academicYear", tenantClause),
      Application.distinct("admission.applyingFor", tenantClause),
    ]);
    return {
      academicYears: (academicYears as string[]).filter(Boolean).sort().reverse(),
      classes: (classes as string[]).filter(Boolean).sort(),
    };
  },
};
