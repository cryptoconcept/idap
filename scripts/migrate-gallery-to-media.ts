/**
 * Moves legacy `Institution.gallery[]` items into the unified `media[]` array
 * as `kind: "IMAGE"` entries, then drops `gallery`.
 *
 * Task 3 removed `gallery` from the Mongoose schema, so a model-level read
 * can no longer see it. This reads and writes through `Institution.collection`
 * — the raw driver — which isn't gated by the schema.
 *
 * A gallery item whose `description` exceeds `MEDIA_CAPTION_MAX` (FeesBasket's
 * caption cap) is never truncated: that would silently and unrecoverably
 * shorten an admin's text with no record of what was lost. Instead the whole
 * institution is skipped — no partial write — and reported under `overlong`,
 * so a human can shorten the field and let a re-run pick it up.
 *
 * The write is a full `$set: { media }`, which would silently destroy any
 * content already sitting in `media` — reachable in production because the
 * new upload flow (media routes) ships before this one-time migration runs,
 * so an admin can genuinely populate `media` before a re-run touches their
 * institution. An institution whose `media` is already non-empty is refused
 * the same way an overlong caption is: skipped entirely, untouched, and
 * reported under `skipped` (kept separate from `overlong` so an operator can
 * tell the two situations apart).
 *
 * Re-running this script only looks idempotent because the first run
 * `$unset`s the very `gallery` field the selector below keys on — that's an
 * accident of the selector, not a guard against overwriting `media`, which is
 * why the check above exists as an explicit, independent condition.
 *
 *   npm run migrate:media                 # report only
 *   npm run migrate:media -- --apply      # write
 */
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import mongoose, { Types } from "mongoose";
import { Institution } from "../src/models/Institution";
import { MEDIA_CAPTION_MAX } from "../src/lib/constants";

export type MigrationReport = {
  scanned: number;
  migrated: number;
  overlong: Array<{ institutionId: string; itemId: string; length: number }>;
  skipped: Array<{ institutionId: string; reason: string }>;
};

/** Shape of a pre-migration gallery item, as it exists only in already-written
 *  documents — the schema no longer declares it. */
interface LegacyGalleryItem {
  _id?: Types.ObjectId;
  imageUrl: string;
  title?: string;
  description?: string;
  sortOrder?: number;
  status?: string;
  uploadedAt?: Date;
}

export async function migrateGalleryToMedia({
  apply,
}: {
  apply: boolean;
}): Promise<MigrationReport> {
  const report: MigrationReport = { scanned: 0, migrated: 0, overlong: [], skipped: [] };

  // "gallery.0 exists" selects exactly the institutions with a non-empty
  // gallery array — an institution with no field, or an empty one, is skipped,
  // which is what makes a second run report zero. This selector says nothing
  // about the state of `media`, which is why it's checked separately below.
  const cursor = Institution.collection.find({ "gallery.0": { $exists: true } });

  for await (const doc of cursor) {
    report.scanned++;
    const institutionId = doc.institutionId as string;
    const gallery = (doc.gallery ?? []) as LegacyGalleryItem[];

    // Refuse to touch an institution that already has real content in
    // `media` — the write below is a full `$set: { media }`, which would
    // silently erase it. Checked first, and independently of the overlong
    // check, because "don't overwrite existing content" is a stricter
    // precondition than "the content we'd write is valid."
    const existingMedia = Array.isArray(doc.media) ? doc.media : [];
    if (existingMedia.length > 0) {
      report.skipped.push({ institutionId, reason: "media array already populated" });
      continue;
    }

    // Check every item's caption length BEFORE writing anything for this
    // institution — one overlong item disqualifies the whole document.
    const overlongItems = gallery
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => (item.description?.length ?? 0) > MEDIA_CAPTION_MAX);

    if (overlongItems.length > 0) {
      for (const { item, index } of overlongItems) {
        report.overlong.push({
          institutionId,
          // No source `_id` on a legacy item means the index alone isn't
          // locatable — the imageUrl is what an operator can actually find
          // the row by.
          itemId: item._id ? String(item._id) : `${item.imageUrl} (index ${index})`,
          length: item.description!.length,
        });
      }
      continue;
    }

    report.migrated++;
    if (!apply) continue;

    const media = gallery.map((item, index) => {
      const mediaItem: Record<string, unknown> = {
        _id: item._id ?? new Types.ObjectId(),
        kind: "IMAGE",
        url: item.imageUrl,
        sortOrder: item.sortOrder ?? index,
        status: item.status ?? "ACTIVE",
        uploadedAt: item.uploadedAt ?? new Date(),
      };
      if (item.title !== undefined) mediaItem.title = item.title;
      if (item.description !== undefined) mediaItem.caption = item.description;
      return mediaItem;
    });

    // The read-time guard above (`existingMedia.length > 0`) only proves
    // `media` was empty at the moment the cursor read this document — not at
    // the moment this write executes. A cursor batch's worth of institutions
    // (driver default 101) can be processed, sequentially, between that read
    // and this write, and the new upload UI ships to production before this
    // migration ever runs, so an admin populating `media` in that window is
    // a real scenario, not a theoretical one. Pushing the same precondition
    // into the filter makes the database — not a stale in-memory read — the
    // thing that enforces it: if something raced us, `matchedCount` is 0 and
    // nothing is overwritten.
    const result = await Institution.collection.updateOne(
      {
        _id: doc._id,
        $or: [{ media: { $exists: false } }, { media: { $size: 0 } }],
      },
      { $set: { media }, $unset: { gallery: "" } },
    );

    if (result.matchedCount === 0) {
      report.migrated--;
      report.skipped.push({
        institutionId,
        reason: "media was written concurrently — re-run",
      });
    }
  }

  return report;
}

// Only true when this file is executed directly (`tsx scripts/migrate-gallery-to-media.ts`),
// not when it's imported — by the test suite, in particular, which must never
// reach the `--apply` / mongoose-connect path below.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const run = async () => {
    config({ path: ".env.local" });
    config({ path: ".env" });

    const APPLY = process.argv.includes("--apply");

    await mongoose.connect(process.env.MONGODB_URI!);

    const report = await migrateGalleryToMedia({ apply: APPLY });

    console.log(`${report.scanned} institution(s) with a legacy gallery`);
    console.log(`${report.migrated} eligible for migration`);

    if (report.overlong.length > 0) {
      console.log(
        `\n${report.overlong.length} item(s) over the ${MEDIA_CAPTION_MAX}-char caption cap — skipped:`,
      );
      for (const item of report.overlong) {
        console.log(`  ${item.institutionId} item ${item.itemId}: ${item.length} chars`);
      }
    }

    if (report.skipped.length > 0) {
      console.log(`\n${report.skipped.length} institution(s) skipped — needs manual review:`);
      for (const item of report.skipped) {
        console.log(`  ${item.institutionId}: ${item.reason}`);
      }
    }

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to write.");
    }

    await mongoose.disconnect();

    if (report.overlong.length > 0 || report.skipped.length > 0) {
      process.exitCode = 1;
    }
  };

  run().catch((error) => {
    console.error("FAILED:", error.message);
    process.exit(1);
  });
}
