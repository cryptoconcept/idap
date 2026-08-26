import "server-only";
import { Types } from "mongoose";
import { AcademicUnit } from "@/models";
import { notFound } from "@/lib/api/errors";

/**
 * Resolves a caller-supplied academic unit id, scoped to the calling
 * institution. Another institution's unit is "no such unit" — NOT_FOUND,
 * never FORBIDDEN — and so is a malformed id, which must never surface as a
 * Mongoose cast error.
 *
 * Returns `null` (not a throw) when no id was supplied at all: for
 * scholarships and offers an absent unit means "applies institution-wide",
 * which is a valid state, unlike a fee structure where the unit is required.
 *
 * Extracted rather than copied because three consumers now need it —
 * `fee-structure.service.ts` predates this and keeps its own inline copy for
 * now, since its variant also selects `pathLabel` for a different purpose and
 * changing it is not this phase's business.
 */
export async function assertOwnedAcademicUnit(
  institutionId: string,
  academicUnitId: string | undefined | null,
): Promise<{ _id: Types.ObjectId; pathLabel: string } | null> {
  if (academicUnitId == null) return null;
  if (!Types.ObjectId.isValid(academicUnitId)) throw notFound("Academic unit not found");

  const unit = await AcademicUnit.findOne({
    _id: new Types.ObjectId(academicUnitId),
    institutionId,
  })
    .select("_id pathLabel")
    .lean<{ _id: Types.ObjectId; pathLabel: string }>();

  if (!unit) throw notFound("Academic unit not found");
  return unit;
}
