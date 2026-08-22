import "server-only";
import { Types } from "mongoose";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Activity } from "@/models";

export type ActivityInput = {
  institutionId: string;
  entityType: string;
  entityId?: string | Types.ObjectId;
  entityRef?: string;
  action: string;
  description?: string;
  performedBy?: string | Types.ObjectId;
  performedByName?: string;
  ipAddress?: string;
};

export const ActivityService = {
  /**
   * Audit writes must never break the action they describe, so failures are
   * logged and swallowed.
   */
  async record(input: ActivityInput): Promise<void> {
    try {
      await connectToDatabase();
      await Activity.create({
        institutionId: input.institutionId,
        entityType: input.entityType,
        entityId: input.entityId ? new Types.ObjectId(String(input.entityId)) : undefined,
        entityRef: input.entityRef,
        action: input.action,
        description: input.description,
        performedBy: input.performedBy ? new Types.ObjectId(String(input.performedBy)) : undefined,
        performedByName: input.performedByName,
        ipAddress: input.ipAddress,
        createdAt: new Date(),
      });
    } catch (error) {
      console.error("[activity] failed to record", input.action, error);
    }
  },

  async listForEntity(institutionId: string, entityType: string, entityId: string, limit = 50) {
    await connectToDatabase();
    const rows = await Activity.find({
      institutionId,
      entityType,
      entityId: new Types.ObjectId(entityId),
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return rows.map((row) => ({
      id: String(row._id),
      action: row.action,
      description: row.description ?? undefined,
      performedByName: row.performedByName ?? undefined,
      createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    }));
  },
};

export type ActivityDTO = Awaited<ReturnType<typeof ActivityService.listForEntity>>[number];
