import "server-only";
import type { FilterQuery } from "mongoose";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Application, DocumentRecord, type ApplicationDoc } from "@/models";
import { generateApplicationNumber } from "./sequence.service";
import { ActivityService } from "./activity.service";
import { NotificationService } from "./notification.service";
import { afterResponse } from "@/lib/after-response";
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
    // Audit AM3: name fields are word-anchored so the query starts at a word
    // boundary ("raj" -> Rajesh, not neeraj) — that lets the studentFullName
    // index serve the match instead of a per-tenant collection scan, and is how
    // people actually search names. Identifier fields (number, phone, email)
    // stay substring so partial lookups — the last 4 digits of a phone, a
    // fragment of an application number — still match. The public directory
    // search anchors names for this same reason.
    const term = escapeRegex(query.q);
    const name = new RegExp(`\\b${term}`, "i");
    const substr = new RegExp(term, "i");
    filter.$or = [
      { applicationNumber: substr },
      { studentFullName: name },
      { "student.firstName": name },
      { "student.lastName": name },
      { "parent.fatherName": name },
      { "parent.motherName": name },
      { "parent.guardianName": name },
      { "parent.phone": substr },
      { "parent.email": substr },
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
    const { data } = input;

    // Audit M4: a retry after a dropped response replays the same key. Return
    // the record the first attempt already wrote instead of creating a second.
    // Checked before consuming an application number, so the common retry
    // leaves no gap in the sequence.
    if (data.idempotencyKey) {
      const existing = await Application.findOne({ institutionId: input.institutionId, idempotencyKey: data.idempotencyKey }).lean();
      if (existing) return serialize(existing as ApplicationRow);
    }

    const applicationNumber = await generateApplicationNumber(input.institutionId);

    let created;
    try {
      created = await Application.create({
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
      idempotencyKey: data.idempotencyKey,
      });
    } catch (error) {
      // The unique index lost a race: a concurrent request with the same key
      // committed first. Return its record, not a duplicate. Any other
      // duplicate-key collision (e.g. the application number) is unexpected —
      // rethrow it.
      if ((error as { code?: number }).code === 11000 && data.idempotencyKey) {
        const won = await Application.findOne({ institutionId: input.institutionId, idempotencyKey: data.idempotencyKey }).lean();
        if (won) return serialize(won as ApplicationRow);
      }
      throw error;
    }

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

    // Deferred, not fire-and-forget — see the matching comment in
    // lead.service.ts. A floating promise here is abandoned when the handler
    // returns and may never run on Vercel; `afterResponse` registers it with
    // the platform, and the catch keeps a push failure away from the family
    // that just submitted.
    await afterResponse(() =>
      NotificationService.notifyNewApplication({
        institutionId: input.institutionId,
        applicationNumber,
        studentName: studentFullName(data.student),
        applyingFor: data.admission.applyingFor,
      }).catch((error) => console.error("[push] application notification failed", error)),
    );

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

    // Audit AM2: the upload writes a canonical DocumentRecord AND an embedded
    // copy on the application, non-transactionally. If the embedded $push is
    // interrupted after the record is written, the file exists and is readable
    // but is missing from this list — the family sees "not uploaded" for a file
    // that exists. Reconcile on this (detail) read: surface any DocumentRecord
    // not reflected in the embedded array, deduped by fileUrl (both share the
    // same /api/documents/{id} url). Detail-only, so no per-row N+1 on the list;
    // applicationId is indexed. v1-API-supplied refs that have no DocumentRecord
    // still show, because the embedded array is the base, not replaced.
    const records = await DocumentRecord.find({ applicationId: row._id })
      .select("_id documentType originalFileName fileName fileUrl uploadedAt")
      .lean();
    const embeddedUrls = new Set((row.documents ?? []).map((d) => d.fileUrl));
    const orphans = records
      .filter((r) => !embeddedUrls.has(r.fileUrl))
      .map((r) => ({
        _id: r._id,
        documentType: r.documentType,
        fileName: r.originalFileName ?? r.fileName,
        fileUrl: r.fileUrl,
        uploadedAt: r.uploadedAt,
      }));
    if (orphans.length > 0) {
      (row as { documents?: unknown[] }).documents = [...(row.documents ?? []), ...orphans];
    }

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
