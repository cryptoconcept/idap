import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { User } from "@/models";
import { hashPassword } from "@/lib/security/password";
import { AppError, notFound, validationError } from "@/lib/api/errors";
import type { CreateStaffInput } from "@/lib/validation/staff";

export type StaffDTO = {
  id: string;
  name: string;
  email: string;
  role: "COUNSELOR" | "FRONT_DESK";
  active: boolean;
  createdAt: string;
};

function serialize(row: {
  _id: unknown;
  name: string;
  email: string;
  role: string;
  active?: boolean;
  createdAt?: Date;
}): StaffDTO {
  return {
    id: String(row._id),
    name: row.name,
    email: row.email,
    role: row.role as "COUNSELOR" | "FRONT_DESK",
    active: row.active ?? true,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

export const StaffService = {
  async create(institutionId: string, input: CreateStaffInput): Promise<StaffDTO> {
    await connectToDatabase();
    const duplicate = await User.findOne({ email: input.email }).select("_id").lean();
    if (duplicate) {
      throw new AppError("CONFLICT", "A user with that email address already exists");
    }

    const created = await User.create({
      institutionId,
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      active: true,
    });

    return serialize(created.toObject());
  },

  async list(institutionId: string): Promise<StaffDTO[]> {
    await connectToDatabase();
    const rows = await User.find({
      institutionId,
      role: { $in: ["COUNSELOR", "FRONT_DESK"] },
    })
      .sort({ createdAt: -1 })
      .lean();
    return rows.map(serialize);
  },

  async setActive(institutionId: string, id: string, active: boolean): Promise<StaffDTO> {
    await connectToDatabase();
    if (!Types.ObjectId.isValid(id)) {
      throw validationError("id: not a valid id");
    }
    const updated = await User.findOneAndUpdate(
      { _id: id, institutionId, role: { $in: ["COUNSELOR", "FRONT_DESK"] } },
      { $set: { active } },
      { new: true },
    ).lean();
    if (!updated) throw notFound("Staff account not found");
    return serialize(updated);
  },
};
