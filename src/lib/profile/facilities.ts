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
