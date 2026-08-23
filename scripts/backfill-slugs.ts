/**
 * Gives every pre-existing institution a slug. Idempotent: only writes where
 * one is absent, so re-running it changes nothing.
 *
 * `slug.service.ts` starts with `import "server-only"`, which only resolves
 * to a no-op under Next's webpack build (the package's `react-server` export
 * condition). Run standalone, that condition isn't set, so invoke this via
 * the npm script below, which sets it explicitly:
 *
 *   npm run backfill:slugs                 # report only
 *   npm run backfill:slugs -- --apply      # write
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import mongoose from "mongoose";
import { Institution } from "../src/models/Institution";
import { claimSlug, slugify } from "../src/services/slug.service";

const APPLY = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  await Institution.syncIndexes();

  const pending = await Institution.find({ slug: { $exists: false } })
    .select("institutionId institutionName locality city")
    .lean();

  console.log(`${pending.length} institution(s) without a slug`);

  for (const row of pending) {
    const base = [row.institutionName, row.locality ?? row.city].filter(Boolean).join(" ");
    if (!APPLY) {
      console.log(`  would set ${row.institutionId} -> ${slugify(base)}`);
      continue;
    }
    const slug = await claimSlug(row.institutionId, base);
    console.log(`  ${row.institutionId} -> ${slug}`);
  }

  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
