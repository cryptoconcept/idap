import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Note } from "@/models";
import type { EntityType } from "@/lib/constants";

export const NoteService = {
  async create(input: {
    institutionId: string;
    entityType: EntityType;
    entityId: string;
    note: string;
    createdBy?: string;
    createdByName?: string;
  }) {
    await connectToDatabase();
    const created = await Note.create({
      institutionId: input.institutionId,
      entityType: input.entityType,
      entityId: new Types.ObjectId(input.entityId),
      note: input.note,
      createdBy: input.createdBy ? new Types.ObjectId(input.createdBy) : undefined,
      createdByName: input.createdByName,
      createdAt: new Date(),
    });

    return {
      id: String(created._id),
      note: created.note,
      createdByName: created.createdByName ?? undefined,
      createdAt: created.createdAt?.toISOString() ?? new Date().toISOString(),
    };
  },

  async list(institutionId: string, entityType: EntityType, entityId: string) {
    await connectToDatabase();
    const rows = await Note.find({
      institutionId,
      entityType,
      entityId: new Types.ObjectId(entityId),
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return rows.map((row) => ({
      id: String(row._id),
      note: row.note,
      createdByName: row.createdByName ?? undefined,
      createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    }));
  },
};

export type NoteDTO = Awaited<ReturnType<typeof NoteService.list>>[number];
