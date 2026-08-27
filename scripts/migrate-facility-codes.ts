/**
 * Converts `Institution.facilities[].code` from the eleven legacy codes onto
 * Task 1's 38-key lowercase vocabulary (`src/lib/profile/facilities.ts`).
 *
 * Nine legacy codes map 1:1 (`LEGACY_FACILITY_CODE_MAP`) and are converted in
 * place. Two (`HOSTEL`, `SPORTS`) have no honest target — `HOSTEL` never
 * recorded which genders it accommodates, and `SPORTS` is a category, not a
 * single facility — so they are left exactly as they are and reported under
 * `unmapped` for a human to re-pick. A free-text custom code that is in
 * neither list (e.g. `ROBOTICS_LAB`) is also left untouched, but is NOT
 * reported: it isn't a legacy code this migration knows anything about, and
 * `unmapped` exists so an operator can act on codes this migration refused to
 * convert, not as an inventory of every code it left alone.
 *
 * Unlike `migrate-gallery-to-media.ts`'s all-or-nothing skip, an institution
 * with both mappable and unmappable codes still gets its mappable codes
 * converted — the unmapped rows are individually identifiable and safe to
 * leave beside converted ones.
 *
 * The write is scoped by `institutionId` and preconditioned on the exact
 * `facilities` array read from the same document, so a concurrent edit
 * between read and write causes `matchedCount === 0` rather than clobbering
 * whatever the concurrent writer produced. That race is never silent: it is
 * reported under `skipped`, forces a non-zero exit alongside `unmapped`, and
 * — deliberately — the `unmapped` rows already collected for that document
 * are NOT retracted. They describe what the migration read, which remains
 * true regardless of whether its own write later lost a race; a re-run
 * overwrites the whole report anyway, so nothing here needs to be provisional.
 * That is also why the unmappable-only branch just below (`if (!changed)
 * continue`) needs no special-casing of its own: both paths already agree —
 * `unmapped` reports the read, `skipped`/`converted` report the write.
 *
 *   npm run migrate:facility-codes                 # report only
 *   npm run migrate:facility-codes -- --apply      # write
 */
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import mongoose from "mongoose";
import { Institution } from "../src/models/Institution";
import { LEGACY_FACILITY_CODE_MAP, UNMAPPABLE_LEGACY_CODES } from "../src/lib/profile/facilities";

export type FacilityMigrationReport = {
  scanned: number;
  converted: number;
  unmapped: Array<{ institutionId: string; code: string; label: string }>;
  skipped: Array<{ institutionId: string; reason: string }>;
};

interface FacilityRow {
  code: string;
  label: string;
  available?: boolean;
  note?: string;
}

const UNMAPPABLE_SET = new Set(UNMAPPABLE_LEGACY_CODES);

// Every legacy code this migration recognises — mappable or deliberately
// unmappable. A custom code in neither list (e.g. `ROBOTICS_LAB`) never
// matches this filter, so an institution holding only custom codes is never
// selected in the first place.
const RELEVANT_CODES = [...Object.keys(LEGACY_FACILITY_CODE_MAP), ...UNMAPPABLE_LEGACY_CODES];

export async function migrateFacilityCodes({
  apply,
}: {
  apply: boolean;
}): Promise<FacilityMigrationReport> {
  const report: FacilityMigrationReport = { scanned: 0, converted: 0, unmapped: [], skipped: [] };

  // Selects exactly the institutions with at least one facility whose code
  // appears in LEGACY_FACILITY_CODE_MAP or UNMAPPABLE_LEGACY_CODES — an
  // institution holding only already-converted or custom codes never matches,
  // which is what makes a second run report zero.
  const cursor = Institution.collection.find({
    "facilities.code": { $in: RELEVANT_CODES },
  });

  for await (const doc of cursor) {
    report.scanned++;
    const institutionId = doc.institutionId as string;
    const facilities = (doc.facilities ?? []) as FacilityRow[];

    let changed = false;
    const nextFacilities = facilities.map((facility) => {
      // `LEGACY_FACILITY_CODE_MAP` is a plain object literal, so a bare
      // `MAP[facility.code]` lookup walks the prototype chain: a facility
      // code of "constructor", "toString", "hasOwnProperty", etc. would
      // return a truthy *inherited* value and get written into `code`
      // through the raw driver, which does no casting to catch it.
      // `Object.hasOwn` restricts the lookup to the map's own keys.
      const mapped = Object.hasOwn(LEGACY_FACILITY_CODE_MAP, facility.code)
        ? LEGACY_FACILITY_CODE_MAP[facility.code]
        : undefined;
      if (mapped) {
        changed = true;
        return { ...facility, code: mapped };
      }
      if (UNMAPPABLE_SET.has(facility.code)) {
        report.unmapped.push({
          institutionId,
          code: facility.code,
          label: facility.label,
        });
      }
      return facility;
    });

    if (!changed) continue;

    report.converted++;
    if (!apply) continue;

    const result = await Institution.collection.updateOne(
      { institutionId, facilities },
      { $set: { facilities: nextFacilities } },
    );

    if (result.matchedCount === 0) {
      report.converted--;
      // The `unmapped` rows pushed above for this institution are NOT
      // retracted — see the header comment. The race itself is reported
      // here, visibly, so a raced run can never look identical to a clean
      // one: `skipped` forces a non-zero exit alongside `unmapped`.
      report.skipped.push({
        institutionId,
        reason: "facilities changed concurrently — re-run",
      });
    }
  }

  return report;
}

// Only true when this file is executed directly (`tsx scripts/migrate-facility-codes.ts`),
// not when it's imported — by the test suite, in particular, which must never
// reach the `--apply` / mongoose-connect path below.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const run = async () => {
    config({ path: ".env.local" });
    config({ path: ".env" });

    const APPLY = process.argv.includes("--apply");

    await mongoose.connect(process.env.MONGODB_URI!);

    const report = await migrateFacilityCodes({ apply: APPLY });

    console.log(`${report.scanned} institution(s) with a legacy facility code`);
    console.log(`${report.converted} institution(s) ${APPLY ? "converted" : "eligible for conversion"}`);

    if (report.unmapped.length > 0) {
      console.log(`\n${report.unmapped.length} unmapped code(s) — left untouched, needs manual review:`);
      for (const row of report.unmapped) {
        console.log(`  ${row.institutionId} ${row.code} (${row.label})`);
      }
    }

    if (report.skipped.length > 0) {
      console.log(`\n${report.skipped.length} institution(s) skipped — needs manual review:`);
      for (const row of report.skipped) {
        console.log(`  ${row.institutionId}: ${row.reason}`);
      }
    }

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to write.");
    }

    await mongoose.disconnect();

    if (report.unmapped.length > 0 || report.skipped.length > 0) {
      process.exitCode = 1;
    }
  };

  run().catch((error) => {
    console.error("FAILED:", error.message);
    process.exit(1);
  });
}
