/**
 * Drops the Phase 4 unique index on `FeeStructure` and builds the Phase 6 one.
 *
 * Mongoose's `autoIndex` creates indexes a schema declares but never drops ones it
 * has stopped declaring. Phase 6a re-keyed fee structures from a free-text
 * `classOrCourse` onto `academicUnitId`; without this, the old
 * `{institutionId, classOrCourse, academicYear}` unique index survives, every new
 * document indexes as `classOrCourse: null`, and the SECOND fee structure for an
 * institution in a given academic year is refused as a duplicate.
 *
 * Idempotent: `syncIndexes()` is a no-op once the collection matches the schema.
 *
 *   npm run sync:fee-indexes                 # report only
 *   npm run sync:fee-indexes -- --apply      # write
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import mongoose from "mongoose";
import { FeeStructure } from "../src/models/FeeStructure";

const APPLY = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);

  const before = await FeeStructure.collection.indexes();
  console.log("current indexes:");
  for (const index of before) console.log(`  ${index.name} ${JSON.stringify(index.key)}`);

  const stale = before.filter((index) => "classOrCourse" in (index.key ?? {}));
  if (stale.length === 0) {
    console.log("\nNo classOrCourse index present — nothing to do.");
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${stale.length} stale index(es) referencing classOrCourse:`);
  for (const index of stale) console.log(`  ${index.name}`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to drop them and build the current set.");
    await mongoose.disconnect();
    return;
  }

  await FeeStructure.syncIndexes();
  const after = await FeeStructure.collection.indexes();
  console.log("\nindexes now:");
  for (const index of after) console.log(`  ${index.name} ${JSON.stringify(index.key)}`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
