import "server-only";
import type { FilterQuery } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Institution, User, type InstitutionDoc } from "@/models";
import { generateInstitutionId, reserveInstitutionId } from "./sequence.service";
import { ActivityService } from "./activity.service";
import { hashPassword } from "@/lib/security/password";
import { AppError, notFound } from "@/lib/api/errors";
import { escapeRegex, requiredIso } from "@/lib/utils/serialize";
import type { InstitutionDTO, Paginated } from "@/lib/types";
import type { InstitutionType } from "@/lib/constants";
import type { z } from "zod";
import type {
  createInstitutionSchema,
  updateInstitutionSchema,
} from "@/lib/validation/institution";

type InstitutionRow = InstitutionDoc;

function serialize(row: InstitutionRow): InstitutionDTO {
  return {
    id: String(row._id),
    institutionId: row.institutionId,
    institutionName: row.institutionName,
    institutionType: row.institutionType as InstitutionType,
    address: row.address ?? undefined,
    city: row.city ?? undefined,
    state: row.state ?? undefined,
    pincode: row.pincode ?? undefined,
    contactPerson: row.contactPerson ?? undefined,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    website: row.website ?? undefined,
    logoUrl: row.logoUrl ?? undefined,
    active: row.active ?? true,
    createdAt: requiredIso(row.createdAt),
    updatedAt: requiredIso(row.updatedAt),
  };
}

export const InstitutionService = {
  serialize,

  async create(
    input: z.infer<typeof createInstitutionSchema>,
    actor: { id: string; name: string },
  ): Promise<{ institution: InstitutionDTO; adminCreated: boolean }> {
    await connectToDatabase();

    const institutionId = input.institutionId ?? (await generateInstitutionId());
    const existing = await Institution.findOne({ institutionId }).select("_id").lean();
    if (existing) {
      throw new AppError("CONFLICT", `Institution ${institutionId} already exists`);
    }
    if (input.institutionId) await reserveInstitutionId(institutionId);

    const created = await Institution.create({
      institutionId,
      institutionName: input.institutionName,
      institutionType: input.institutionType,
      address: input.address,
      city: input.city,
      state: input.state,
      pincode: input.pincode,
      contactPerson: input.contactPerson,
      phone: input.phone,
      email: input.email,
      website: input.website,
      logoUrl: input.logoUrl,
      active: true,
    });

    let adminCreated = false;
    if (input.adminEmail && input.adminPassword) {
      const duplicate = await User.findOne({ email: input.adminEmail }).select("_id").lean();
      if (duplicate) {
        throw new AppError("CONFLICT", "A user with that email address already exists");
      }
      await User.create({
        institutionId,
        name: input.adminName ?? input.institutionName,
        email: input.adminEmail,
        passwordHash: await hashPassword(input.adminPassword),
        role: "INSTITUTION_ADMIN",
        active: true,
      });
      adminCreated = true;
    }

    await ActivityService.record({
      institutionId,
      entityType: "INSTITUTION",
      entityId: created._id,
      entityRef: institutionId,
      action: "Institution created",
      description: `${input.institutionName} (${institutionId}) created`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return { institution: serialize(created.toObject() as InstitutionRow), adminCreated };
  },

  async update(
    institutionId: string,
    patch: z.infer<typeof updateInstitutionSchema>,
    actor: { id: string; name: string },
  ): Promise<InstitutionDTO> {
    await connectToDatabase();
    const before = await Institution.findOne({ institutionId }).lean();
    if (!before) throw notFound("Institution not found");

    const update = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );

    const updated = await Institution.findOneAndUpdate(
      { institutionId },
      { $set: update },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Institution not found");

    if (patch.active !== undefined && patch.active !== (before.active ?? true)) {
      await ActivityService.record({
        institutionId,
        entityType: "INSTITUTION",
        entityId: updated._id,
        entityRef: institutionId,
        action: patch.active ? "Institution activated" : "Institution deactivated",
        performedBy: actor.id,
        performedByName: actor.name,
      });
    } else {
      await ActivityService.record({
        institutionId,
        entityType: "INSTITUTION",
        entityId: updated._id,
        entityRef: institutionId,
        action: "Institution updated",
        performedBy: actor.id,
        performedByName: actor.name,
      });
    }

    return serialize(updated as InstitutionRow);
  },

  async getById(institutionId: string): Promise<InstitutionDTO> {
    await connectToDatabase();
    const row = await Institution.findOne({ institutionId }).lean();
    if (!row) throw notFound("Institution not found");
    return serialize(row as InstitutionRow);
  },

  /** Public branding lookup for the hosted application pages. Inactive tenants 404. */
  async getPublicBranding(institutionId: string) {
    await connectToDatabase();
    const row = await Institution.findOne({ institutionId: institutionId.toUpperCase(), active: true })
      .select("institutionId institutionName institutionType address city state pincode phone email website logoUrl")
      .lean();
    if (!row) return null;
    return {
      institutionId: row.institutionId,
      institutionName: row.institutionName,
      institutionType: row.institutionType,
      address: row.address ?? undefined,
      city: row.city ?? undefined,
      state: row.state ?? undefined,
      pincode: row.pincode ?? undefined,
      phone: row.phone ?? undefined,
      email: row.email ?? undefined,
      website: row.website ?? undefined,
      logoUrl: row.logoUrl ?? undefined,
    };
  },

  async list(query: {
    q?: string;
    active?: boolean;
    page?: number;
    pageSize?: number;
  }): Promise<Paginated<InstitutionDTO>> {
    await connectToDatabase();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const filter: FilterQuery<InstitutionDoc> = {};
    if (query.active !== undefined) filter.active = query.active;
    if (query.q) {
      const pattern = new RegExp(escapeRegex(query.q), "i");
      filter.$or = [{ institutionId: pattern }, { institutionName: pattern }, { city: pattern }];
    }

    const [rows, total] = await Promise.all([
      Institution.find(filter)
        .sort({ institutionId: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Institution.countDocuments(filter),
    ]);

    return {
      items: rows.map((row) => serialize(row as InstitutionRow)),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  },

};
