/**
 * Facility vocabulary, aligned key-for-key with PassPercent's
 * `utils/facilities.js` so a school's selections map 1:1 onto what that
 * platform stores. Their file warns "NEVER rename a key; add new ones
 * instead, or stored selections vanish" — the same applies here.
 *
 * The validation schema still accepts any code, so this list can grow
 * without a migration.
 */
export const FACILITY_GROUPS: { group: string; items: { code: string; label: string }[] }[] = [
  {
    group: "Academics",
    items: [
      { code: "smart_classes", label: "Smart Classrooms" },
      { code: "library", label: "Library" },
      { code: "computer_lab", label: "Computer Lab" },
      { code: "science_lab", label: "Science Labs" },
      { code: "language_lab", label: "Language Lab" },
      { code: "ac_classrooms", label: "AC Classrooms" },
      { code: "wifi", label: "Campus Wi-Fi" },
      { code: "digital_library", label: "Digital Library" },
    ],
  },
  {
    group: "Sports",
    items: [
      { code: "playground", label: "Playground" },
      { code: "indoor_games", label: "Indoor Games" },
      { code: "swimming", label: "Swimming Pool" },
      { code: "gym", label: "Gymnasium" },
      { code: "athletics", label: "Athletics Track" },
      { code: "basketball", label: "Basketball Court" },
      { code: "cricket", label: "Cricket Ground" },
      { code: "yoga", label: "Yoga / Meditation" },
    ],
  },
  {
    group: "Infrastructure",
    items: [
      { code: "auditorium", label: "Auditorium" },
      { code: "cafeteria", label: "Cafeteria" },
      { code: "transport", label: "School Transport" },
      { code: "medical_room", label: "Medical Room" },
      { code: "meals", label: "Meals / Mess" },
      { code: "power_backup", label: "Power Backup" },
      { code: "ramp_access", label: "Wheelchair Access" },
    ],
  },
  {
    group: "Safety",
    items: [
      { code: "cctv", label: "CCTV Surveillance" },
      { code: "security_guards", label: "Security Staff" },
      { code: "fire_safety", label: "Fire Safety" },
      { code: "gps_buses", label: "GPS-tracked Buses" },
      { code: "visitor_check", label: "Visitor Screening" },
      { code: "counselor", label: "Student Counselor" },
    ],
  },
  {
    group: "Extracurricular",
    items: [
      { code: "art", label: "Art & Craft" },
      { code: "music", label: "Music" },
      { code: "dance", label: "Dance" },
      { code: "drama", label: "Drama / Theatre" },
      { code: "debate", label: "Debate & MUN" },
      { code: "robotics", label: "Robotics / STEM Club" },
    ],
  },
  {
    group: "Boarding",
    items: [
      { code: "boys_hostel", label: "Boys Hostel" },
      { code: "girls_hostel", label: "Girls Hostel" },
      { code: "day_boarding", label: "Day Boarding" },
    ],
  },
];

export const FACILITY_CODES: string[] = FACILITY_GROUPS.flatMap((g) => g.items.map((i) => i.code));

/** The nine legacy codes whose meaning survives conversion intact. */
export const LEGACY_FACILITY_CODE_MAP: Record<string, string> = {
  LIBRARY: "library",
  SCIENCE_LAB: "science_lab",
  COMPUTER_LAB: "computer_lab",
  PLAYGROUND: "playground",
  AUDITORIUM: "auditorium",
  TRANSPORT: "transport",
  CAFETERIA: "cafeteria",
  SMART_CLASSROOM: "smart_classes",
  DIGITAL_LEARNING: "digital_library",
};

/**
 * Deliberately unmapped. `HOSTEL` does not record which genders are
 * accommodated, and the target vocabulary splits into `boys_hostel` /
 * `girls_hostel` — picking either would assert a fact the school never stated.
 * `SPORTS` is a category, not a facility; expanding it into specific sports
 * would invent claims. Both are reported for an admin to re-pick.
 */
export const UNMAPPABLE_LEGACY_CODES: string[] = ["HOSTEL", "SPORTS"];

/**
 * `LEGACY_FACILITY_CODE_MAP` keyed the other way round — new code to the
 * legacy code that means the same thing — derived from that map rather than
 * duplicated by hand, so the two can never drift out of sync. `HOSTEL` and
 * `SPORTS` never appear here: they are absent from `LEGACY_FACILITY_CODE_MAP`
 * by design (see `UNMAPPABLE_LEGACY_CODES`), so nothing in this reverse map
 * can ever point at them either.
 */
const NEW_TO_LEGACY_FACILITY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_FACILITY_CODE_MAP).map(([legacy, current]) => [current, legacy]),
);

/**
 * Whether `code` (always a new-vocabulary code — every caller passes a
 * `FACILITY_GROUPS` chip or a freshly `toFacilityCode`-derived one) is
 * already represented among `selectedCodes`, treating an un-migrated legacy
 * row as equivalent to the new code it will become.
 *
 * This matters at every institution, not just stale ones: `migrate:
 * facility-codes --apply` has never been run, so EVERY institution is
 * carrying old-vocabulary codes like `LIBRARY` for the entire window between
 * deploy and migration. Without this equivalence, the `library` chip reads
 * as unpressed against a stored `LIBRARY` row, and one click appends a
 * second, redundant `library` entry alongside the untouched `LIBRARY` one —
 * reproduced in the browser during Task 13's verification.
 *
 * Display and duplicate-prevention ONLY: this never rewrites `selectedCodes`
 * and never touches the stored row. Converting `LIBRARY` to `library` is the
 * migration script's job — doing it silently from here, on render or on a
 * click the admin didn't intend as an edit, would be an unrequested write.
 * Removing the legacy row (by deselecting it) is a different, admin-driven
 * action and is unaffected by this function.
 */
export function isFacilitySelected(selectedCodes: string[], code: string): boolean {
  const legacyEquivalent = NEW_TO_LEGACY_FACILITY_CODE[code];
  return selectedCodes.some((selected) => selected === code || selected === legacyEquivalent);
}

/**
 * `entries` with the row a suggestion chip stands for removed — the removal
 * counterpart of `isFacilitySelected`, and deliberately expressed in terms of
 * it so the two can never disagree about what "the library chip's row" means.
 *
 * Plain `entry.code !== code` is wrong here for the same reason plain equality
 * is wrong in `isFacilitySelected`: on an un-migrated institution the stored
 * row is `LIBRARY`, so a filter keyed on `library` matches nothing, the array
 * comes back identical, and the chip that renders pressed cannot be
 * un-pressed. A chip whose pressed state says "selected" must always be
 * clickable back to "not selected".
 *
 * Removing the legacy row is the one admin-driven action that may take a
 * legacy code out of storage — unlike the pressed state, which only ever
 * displays. Converting the rows that stay is still the migration's job.
 */
export function withoutFacility<T extends { code: string }>(entries: T[], code: string): T[] {
  return entries.filter((entry) => !isFacilitySelected([entry.code], code));
}
