/**
 * Gives every pre-existing institution a slug. Idempotent: only writes where
 * one is absent, so re-running it changes nothing.
 *
 *   npx tsx scripts/backfill-slugs.ts            # report only
 *   npx tsx scripts/backfill-slugs.ts --apply    # write
 */
import Module from "node:module";

/**
 * `slug.service.ts` (correctly) starts with `import "server-only"` so it can
 * never be pulled into a client bundle. That guard is enforced by Next's
 * webpack build resolving the package's `react-server` export condition to a
 * no-op; this script runs standalone under tsx, outside that build, where the
 * package's default export throws unconditionally. Stubbed the same way
 * `vitest.config.ts` aliases it for tests.
 *
 * This has to run before `slug.service` is loaded, but tsx's CJS transform
 * hoists top-level `import` requires ahead of ordinary statements, so a plain
 * static import of the service would already have thrown by the time this
 * patch applied. `slug.service` is imported dynamically inside `main()`
 * instead, below, which is not hoisted — it runs exactly where it's written.
 */
const moduleWithLoad = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(moduleWithLoad, request, parent, isMain);
};

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import mongoose from "mongoose";
import { Institution } from "../src/models/Institution";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { claimSlug, slugify } = await import("../src/services/slug.service");

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
