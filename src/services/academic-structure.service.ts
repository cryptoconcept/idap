import "server-only";
import { Types } from "mongoose";
import type { z } from "zod";
import { connectToDatabase } from "@/lib/db/mongoose";
import { AcademicUnit, Institution, type AcademicUnitDoc } from "@/models";
import { notFound, validationError } from "@/lib/api/errors";
import { ACADEMIC_UNIT_MAX_PER_INSTITUTION, type AcademicSegment } from "@/lib/constants";
import {
  ACADEMIC_BLUEPRINTS,
  PATH_SEPARATOR,
  defaultSegmentsFor,
  levelFor,
  orderSegments,
} from "@/lib/academic/blueprints";
import type {
  createAcademicUnitSchema,
  reorderAcademicUnitsSchema,
  updateAcademicUnitSchema,
} from "@/lib/validation/academic-structure";
import { deriveOfferings, type DerivedOfferings } from "@/lib/academic/offerings";
import { ActivityService } from "./activity.service";

type CreateInput = z.infer<typeof createAcademicUnitSchema>;
type UpdateInput = z.infer<typeof updateAcademicUnitSchema>;
type ReorderInput = z.infer<typeof reorderAcademicUnitsSchema>;

const ENTITY_TYPE = "ACADEMIC_UNIT";

export type AcademicUnitDTO = {
  id: string;
  segment: AcademicSegment;
  parentId: string | null;
  depth: number;
  levelKey: string;
  levelLabel: string;
  name: string;
  pathLabel: string;
  sortOrder: number;
  active: boolean;
};

/** A malformed id must read as "no such unit", not as a 500. */
function toObjectId(unitId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(unitId)) throw notFound("Academic unit not found");
  return new Types.ObjectId(unitId);
}

function serialize(row: AcademicUnitDoc): AcademicUnitDTO {
  const segment = row.segment as AcademicSegment;
  const level = levelFor(segment, row.depth);
  return {
    id: String(row._id),
    segment,
    parentId: row.parentId ? String(row.parentId) : null,
    depth: row.depth,
    // A depth past the blueprint's end can only come from a blueprint edited
    // after the data was written; it renders as an unnamed tier rather than
    // crashing the page it appears on.
    levelKey: level?.key ?? "",
    levelLabel: level?.label ?? `Level ${row.depth + 1}`,
    name: row.name,
    pathLabel: row.pathLabel,
    sortOrder: row.sortOrder ?? 0,
    active: row.active !== false,
  };
}

/** Every read is scoped by institutionId, so a foreign id is simply not found. */
async function findOwned(institutionId: string, unitId: string): Promise<AcademicUnitDoc> {
  const row = await AcademicUnit.findOne({
    _id: toObjectId(unitId),
    institutionId,
  }).lean<AcademicUnitDoc>();
  if (!row) throw notFound("Academic unit not found");
  return row;
}

/** The stored selection, or the institution type's default when never chosen. */
async function segmentsFor(institutionId: string): Promise<AcademicSegment[]> {
  const institution = await Institution.findOne({ institutionId })
    .select("institutionType academic.segments")
    .lean();
  if (!institution) throw notFound("Institution not found");

  const stored = (institution.academic as { segments?: string[] } | undefined)?.segments;
  return stored?.length ? orderSegments(stored) : defaultSegmentsFor(institution.institutionType);
}

async function pathLabelFor(
  institutionId: string,
  parentId: Types.ObjectId | null,
  name: string,
): Promise<string> {
  if (!parentId) return name;
  const parent = await AcademicUnit.findOne({ _id: parentId, institutionId })
    .select("pathLabel")
    .lean();
  // A missing parent means the tree changed underneath this write. Failing is
  // the right direction: silently returning a bare `name` would give a child a
  // root-shaped pathLabel and leave it permanently wrong.
  if (!parent) throw notFound("Academic unit not found");
  return `${parent.pathLabel}${PATH_SEPARATOR}${name}`;
}

/** `parentId` as the map key a root can also use. */
const parentKey = (parentId: Types.ObjectId | null | undefined): string =>
  parentId ? String(parentId) : "";

type TreeRow = {
  _id: Types.ObjectId;
  parentId: Types.ObjectId | null;
  name: string;
  pathLabel: string;
};

function childrenBucket(rows: TreeRow[]): Map<string, TreeRow[]> {
  const childrenOf = new Map<string, TreeRow[]>();
  for (const row of rows) {
    const key = parentKey(row.parentId);
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(row);
    else childrenOf.set(key, [row]);
  }
  return childrenOf;
}

/**
 * A rename changes every descendant's `pathLabel`. The segment is read once and
 * rewritten in one bulk write — correct at the tree sizes this design commits
 * to (tens of nodes), and `ACADEMIC_UNIT_MAX_PER_INSTITUTION` is what keeps it
 * there.
 */
async function rewriteDescendantPaths(
  institutionId: string,
  root: { _id: Types.ObjectId; segment: string; pathLabel: string },
): Promise<void> {
  const rows = await AcademicUnit.find({ institutionId, segment: root.segment })
    .select("_id parentId name pathLabel")
    .lean<TreeRow[]>();

  const childrenOf = childrenBucket(rows);
  // If this inferred type proves awkward, import `AnyBulkWriteOperation` from
  // mongoose and write `AnyBulkWriteOperation<AcademicUnitDoc>[]` instead. Do
  // not fall back to `any`.
  const operations: Parameters<typeof AcademicUnit.bulkWrite>[0] = [];
  const queue = [{ id: String(root._id), pathLabel: root.pathLabel }];
  const seen = new Set<string>([String(root._id)]);

  while (queue.length > 0) {
    const current = queue.shift() as { id: string; pathLabel: string };
    for (const child of childrenOf.get(current.id) ?? []) {
      const childId = String(child._id);
      // parentId is immutable after creation, so a cycle can only come from
      // direct DB corruption — but without this the walk spins forever.
      if (seen.has(childId)) continue;
      seen.add(childId);
      const pathLabel = `${current.pathLabel}${PATH_SEPARATOR}${child.name}`;
      if (pathLabel !== child.pathLabel) {
        operations.push({
          updateOne: {
            filter: { _id: child._id, institutionId },
            update: { $set: { pathLabel } },
          },
        });
      }
      // Queued whether or not it changed: a deeper descendant may still need
      // rewriting even when this one already matched.
      queue.push({ id: childId, pathLabel });
    }
  }

  if (operations.length > 0) await AcademicUnit.bulkWrite(operations);
}

/** Every id in the subtree rooted at `root`, the root included. */
async function subtreeIds(
  institutionId: string,
  root: { _id: Types.ObjectId; segment: string },
): Promise<Types.ObjectId[]> {
  const rows = await AcademicUnit.find({ institutionId, segment: root.segment })
    .select("_id parentId name pathLabel")
    .lean<TreeRow[]>();

  const childrenOf = childrenBucket(rows);
  const ids: Types.ObjectId[] = [];
  const queue: Types.ObjectId[] = [root._id];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift() as Types.ObjectId;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
    for (const child of childrenOf.get(key) ?? []) queue.push(child._id);
  }
  return ids;
}

export const AcademicStructureService = {
  async list(institutionId: string): Promise<AcademicUnitDTO[]> {
    await connectToDatabase();
    const rows = await AcademicUnit.find({ institutionId })
      .sort({ segment: 1, depth: 1, sortOrder: 1 })
      .lean<AcademicUnitDoc[]>();
    return rows.map(serialize);
  },

  async create(
    institutionId: string,
    input: CreateInput,
    actor: { id: string; name: string },
  ): Promise<AcademicUnitDTO> {
    await connectToDatabase();

    const segments = await segmentsFor(institutionId);
    if (!segments.includes(input.segment)) {
      throw validationError(
        `segment: this institution has not selected ${input.segment} — add it before creating units under it`,
      );
    }

    let parentId: Types.ObjectId | null = null;
    let depth = 0;
    // Built from the parent we have already loaded. Re-reading it after the
    // round-trips below would open a window where a concurrent delete makes the
    // lookup miss and this unit silently gets a root-shaped pathLabel despite
    // having a parent.
    let pathLabel = input.name;

    if (input.parentId) {
      // Scoped by institutionId, so a foreign parent reads as "no such parent"
      // — NOT_FOUND, never FORBIDDEN.
      const parent = await findOwned(institutionId, input.parentId);
      if (parent.segment !== input.segment) {
        throw validationError("parentId: the parent belongs to a different segment");
      }
      parentId = parent._id;
      depth = parent.depth + 1;
      pathLabel = `${parent.pathLabel}${PATH_SEPARATOR}${input.name}`;
    }

    if (!levelFor(input.segment, depth)) {
      const { levels } = ACADEMIC_BLUEPRINTS[input.segment];
      throw validationError(
        `parentId: nothing goes beneath ${levels[levels.length - 1]?.label} in ${input.segment}`,
      );
    }

    const total = await AcademicUnit.countDocuments({ institutionId });
    if (total >= ACADEMIC_UNIT_MAX_PER_INSTITUTION) {
      throw validationError(
        `An institution can hold at most ${ACADEMIC_UNIT_MAX_PER_INSTITUTION} academic units`,
      );
    }

    // Appended last among its siblings. Two tabs racing here land on the same
    // sortOrder, which is cosmetic and fixed by one reorder — unlike a
    // duplicate name, which the unique index refuses outright.
    const last = await AcademicUnit.findOne({ institutionId, segment: input.segment, parentId })
      .sort({ sortOrder: -1 })
      .select("sortOrder")
      .lean();

    const created = await AcademicUnit.create({
      institutionId,
      segment: input.segment,
      parentId,
      depth,
      name: input.name,
      pathLabel,
      sortOrder: (last?.sortOrder ?? -1) + 1,
      active: true,
    });

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityId: created._id,
      entityRef: institutionId,
      action: "Academic unit created",
      description: created.pathLabel,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(created.toObject() as AcademicUnitDoc);
  },

  async update(
    institutionId: string,
    unitId: string,
    patch: UpdateInput,
    actor: { id: string; name: string },
  ): Promise<AcademicUnitDTO> {
    await connectToDatabase();
    const before = await findOwned(institutionId, unitId);

    const set: Record<string, unknown> = {};
    if (patch.active !== undefined) set.active = patch.active;

    const renaming = patch.name !== undefined && patch.name !== before.name;
    if (renaming) {
      set.name = patch.name;
      set.pathLabel = await pathLabelFor(institutionId, before.parentId ?? null, patch.name as string);
    }

    const updated = await AcademicUnit.findOneAndUpdate(
      { _id: before._id, institutionId },
      { $set: set },
      { new: true },
    ).lean<AcademicUnitDoc>();
    if (!updated) throw notFound("Academic unit not found");

    if (renaming) await rewriteDescendantPaths(institutionId, updated);

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityId: updated._id,
      entityRef: institutionId,
      action: renaming ? "Academic unit renamed" : "Academic unit updated",
      description: updated.pathLabel,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return serialize(updated);
  },

  async remove(
    institutionId: string,
    unitId: string,
    actor: { id: string; name: string },
  ): Promise<{ deleted: number }> {
    await connectToDatabase();
    const before = await findOwned(institutionId, unitId);

    // Phase 6 obligation (spec §15): once `FeeStructure.academicUnitId` exists,
    // a delete whose subtree is referenced by any fee structure must be refused
    // right here. Nothing references a unit in Phase 5, so this is unguarded.
    const ids = await subtreeIds(institutionId, before);
    const result = await AcademicUnit.deleteMany({ _id: { $in: ids }, institutionId });

    // The count reported is what the database actually removed, not what we
    // intended to remove. The two are identical whenever scoping is correct —
    // reporting the intended number would hide the case where it is not.
    if (result.deletedCount === 0) throw notFound("Academic unit not found");

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityId: before._id,
      entityRef: institutionId,
      action: "Academic unit deleted",
      description:
        result.deletedCount > 1
          ? `${before.pathLabel} and ${result.deletedCount - 1} unit(s) beneath it`
          : before.pathLabel,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return { deleted: result.deletedCount };
  },

  async reorder(
    institutionId: string,
    input: ReorderInput,
    actor: { id: string; name: string },
  ): Promise<AcademicUnitDTO[]> {
    await connectToDatabase();

    const parentId = input.parentId ? toObjectId(input.parentId) : null;
    const siblings = await AcademicUnit.find({
      institutionId,
      segment: input.segment,
      parentId,
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId }[]>();

    const actual = new Set(siblings.map((row) => String(row._id)));
    const requested = new Set(input.orderedIds);

    // An exact set match, not a subset. A partial list would leave the
    // unmentioned siblings holding stale sortOrders and interleave them
    // silently; an id from another parent — or another tenant — is simply not
    // in `actual`, so this is the tenant check too.
    const matches =
      requested.size === input.orderedIds.length &&
      requested.size === actual.size &&
      input.orderedIds.every((id) => actual.has(id));
    if (!matches) {
      throw validationError("orderedIds: must list every sibling exactly once");
    }

    await AcademicUnit.bulkWrite(
      input.orderedIds.map((id, index) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(id), institutionId },
          update: { $set: { sortOrder: index } },
        },
      })),
    );

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityRef: institutionId,
      action: "Academic units reordered",
      description: `${input.orderedIds.length} unit(s) in ${input.segment}`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    const rows = await AcademicUnit.find({ institutionId, segment: input.segment, parentId })
      .sort({ sortOrder: 1 })
      .lean<AcademicUnitDoc[]>();
    return rows.map(serialize);
  },

  async getSegments(institutionId: string): Promise<AcademicSegment[]> {
    await connectToDatabase();
    return segmentsFor(institutionId);
  },

  async setSegments(
    institutionId: string,
    segments: readonly string[],
    actor: { id: string; name: string },
  ): Promise<AcademicSegment[]> {
    await connectToDatabase();

    const next = orderSegments(segments);
    const current = await segmentsFor(institutionId);
    const removed = current.filter((segment) => !next.includes(segment));

    if (removed.length > 0) {
      // Refused rather than cascaded: deselecting a segment is a configuration
      // change, and silently deleting a term's worth of structure behind it is
      // not something an unticked checkbox should be able to do.
      const blocking = await AcademicUnit.countDocuments({
        institutionId,
        segment: { $in: removed },
      });
      if (blocking > 0) {
        throw validationError(
          `segments: delete the ${blocking} unit(s) under ${removed.join(", ")} before deselecting`,
        );
      }
    }

    await Institution.updateOne({ institutionId }, { $set: { "academic.segments": next } });

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityRef: institutionId,
      action: "Academic segments updated",
      description: next.join(", "),
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return next;
  },

  /** Whether the profile still holds hand-typed offerings worth importing. */
  async hasProfileOfferings(institutionId: string): Promise<boolean> {
    await connectToDatabase();
    const institution = await Institution.findOne({ institutionId })
      .select("academic.classesOffered academic.coursesOffered")
      .lean();
    const academic = (institution?.academic ?? {}) as {
      classesOffered?: string[];
      coursesOffered?: string[];
    };
    return (academic.classesOffered?.length ?? 0) + (academic.coursesOffered?.length ?? 0) > 0;
  },

  /**
   * The one-time import that keeps removing two profile inputs from costing an
   * institution the data it already typed. Idempotent by construction: the
   * zero-units precondition means a second call finds units and refuses.
   */
  async seedFromProfile(
    institutionId: string,
    actor: { id: string; name: string },
  ): Promise<{ created: number; skipped: number }> {
    await connectToDatabase();

    const existing = await AcademicUnit.countDocuments({ institutionId });
    if (existing > 0) {
      throw validationError(
        "Seeding is only available while the academic structure is still empty",
      );
    }

    const institution = await Institution.findOne({ institutionId })
      .select("institutionType academic")
      .lean();
    if (!institution) throw notFound("Institution not found");

    const academic = (institution.academic ?? {}) as {
      classesOffered?: string[];
      coursesOffered?: string[];
      segments?: string[];
    };
    const classes = academic.classesOffered ?? [];
    const courses = academic.coursesOffered ?? [];
    if (classes.length === 0 && courses.length === 0) {
      throw validationError("There is nothing on the profile to seed from");
    }

    const segments = academic.segments?.length
      ? orderSegments(academic.segments)
      : defaultSegmentsFor(institution.institutionType);

    // Preferred segment per array, each with one fallback. `segments` always
    // holds at least one entry, so both always resolve and no entry is ever
    // left with nowhere to go.
    const fallback = segments[0] as AcademicSegment;
    const classSegment: AcademicSegment = segments.includes("SCHOOL") ? "SCHOOL" : fallback;
    const courseSegment: AcademicSegment =
      segments.find((segment) => segment !== "SCHOOL") ?? fallback;

    const pending = [
      ...classes.map((name) => ({ segment: classSegment, name })),
      ...courses.map((name) => ({ segment: courseSegment, name })),
    ];

    const seen = new Set<string>();
    const nextSortOrder = new Map<AcademicSegment, number>();
    const documents: Record<string, unknown>[] = [];
    let skipped = 0;

    for (const entry of pending) {
      const name = String(entry.name).trim();
      const key = `${entry.segment}:${name}`;
      if (name.length === 0 || seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);

      const sortOrder = nextSortOrder.get(entry.segment) ?? 0;
      nextSortOrder.set(entry.segment, sortOrder + 1);
      documents.push({
        institutionId,
        segment: entry.segment,
        parentId: null,
        depth: 0,
        name,
        pathLabel: name,
        sortOrder,
        active: true,
      });
    }

    if (documents.length > 0) await AcademicUnit.insertMany(documents);

    await ActivityService.record({
      institutionId,
      entityType: ENTITY_TYPE,
      entityRef: institutionId,
      action: "Academic structure seeded from profile",
      description: `${documents.length} created, ${skipped} skipped`,
      performedBy: actor.id,
      performedByName: actor.name,
    });

    return { created: documents.length, skipped };
  },

  /**
   * `null` when there is nothing to derive. The public profile path then leaves
   * the stored arrays alone, so an institution that has not built a tree — or
   * has deactivated all of it — keeps publishing exactly what it publishes
   * today. Nothing disappears from a live profile on release day.
   */
  async offeringsFor(institutionId: string): Promise<DerivedOfferings | null> {
    await connectToDatabase();
    const units = await AcademicStructureService.list(institutionId);
    if (units.length === 0) return null;

    const offerings = deriveOfferings(units, await segmentsFor(institutionId));
    if (offerings.classesOffered.length === 0 && offerings.coursesOffered.length === 0) {
      return null;
    }
    return offerings;
  },
};
