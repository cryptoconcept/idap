/**
 * Suggestions for the facilities picker. A convenience only — the
 * `facilities` schema in `@/lib/validation/institution` accepts any code, so
 * this list can grow without a schema change or a migration.
 */
export const FACILITY_SUGGESTIONS: { code: string; label: string }[] = [
  { code: "LIBRARY", label: "Library" },
  { code: "SCIENCE_LAB", label: "Science Lab" },
  { code: "COMPUTER_LAB", label: "Computer Lab" },
  { code: "SMART_CLASSROOM", label: "Smart Classroom" },
  { code: "PLAYGROUND", label: "Playground" },
  { code: "AUDITORIUM", label: "Auditorium" },
  { code: "HOSTEL", label: "Hostel" },
  { code: "TRANSPORT", label: "Transport" },
  { code: "CAFETERIA", label: "Cafeteria" },
  { code: "SPORTS", label: "Sports" },
  { code: "DIGITAL_LEARNING", label: "Digital Learning" },
];
