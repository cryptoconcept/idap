/**
 * Bootstraps a usable platform: one super admin, two institutions with their
 * own admins, and a first API credential. Safe to re-run — existing records are
 * left alone and the generated secret is printed once.
 *
 *   npm run seed            # accounts only
 *   npm run seed -- --demo  # plus sample enquiries/applications for INS0002
 */
import { config } from "dotenv";
import mongoose from "mongoose";
import { Institution } from "../src/models/Institution";
import { User } from "../src/models/User";
import { Lead } from "../src/models/Lead";
import { Application } from "../src/models/Application";
import { ApiClient } from "../src/models/ApiClient";
import { Counter } from "../src/models/Counter";
import { Result } from "../src/models/Result";
import { hashPassword } from "../src/lib/security/password";
import { generateKeyId, generateSecret, hashSecret } from "../src/lib/security/tokens";

config({ path: ".env.local" });
config({ path: ".env" });

const WITH_DEMO = process.argv.includes("--demo");

/**
 * A minimal, standalone copy of `slug.service.ts`'s `slugify()`. Not imported
 * from there directly: that module starts with `import "server-only"`, which
 * only resolves to a no-op under Next's build (the `react-server` export
 * condition); run standalone via plain `tsx` — as `npm run seed` does, unlike
 * `npm run backfill:slugs` — the same import throws immediately. Good enough
 * for the two fixed, ASCII institution names seeded here; not a general
 * replacement for the real service, which also handles collisions.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/g, "");
}

async function nextSequence(scope: string): Promise<number> {
  const counter = await Counter.findOneAndUpdate(
    { _id: scope },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return counter?.seq ?? 1;
}

async function ensureInstitution(input: {
  institutionId: string;
  institutionName: string;
  institutionType: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  website: string;
  contactPerson: string;
  // --- profile fields, so /profile and the dashboard aren't empty locally ---
  regionCode?: string;
  tagline?: string;
  description?: string;
  establishedYear?: number;
  academic?: Record<string, unknown>;
  management?: Record<string, unknown>;
  facilities?: Array<Record<string, unknown>>;
}) {
  const existing = await Institution.findOne({ institutionId: input.institutionId }).lean();
  if (existing) {
    console.log(`  · ${input.institutionId} already exists — skipped`);
    return;
  }
  // Real institutions get their slug from `allocateSlug` at creation time
  // (`InstitutionService.create`); this script bypasses that service (see the
  // `slugify` note above) and assigns one directly from name + city.
  const slug = slugify(`${input.institutionName} ${input.city}`);
  await Institution.create({ ...input, active: true, slug });

  const numeric = Number(input.institutionId.replace("INS", ""));
  await Counter.updateOne(
    { _id: "PLATFORM:INSTITUTION", seq: { $lt: numeric } },
    { $set: { seq: numeric } },
    { upsert: true },
  );
  console.log(`  · created ${input.institutionId} — ${input.institutionName}`);
}

async function ensureUser(input: {
  name: string;
  email: string;
  password: string;
  role: "SUPER_ADMIN" | "INSTITUTION_ADMIN";
  institutionId?: string;
}) {
  const existing = await User.findOne({ email: input.email }).lean();
  if (existing) {
    console.log(`  · ${input.email} already exists — skipped`);
    return;
  }
  await User.create({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    institutionId: input.institutionId,
    active: true,
  });
  console.log(`  · created ${input.role.padEnd(17)} ${input.email}  /  ${input.password}`);
}

async function ensureApiClient(institutionId: string, name: string) {
  const existing = await ApiClient.findOne({ institutionId, name }).lean();
  if (existing) {
    console.log(`  · API key "${name}" already exists — skipped (secret cannot be re-shown)`);
    return;
  }

  const keyId = generateKeyId();
  const secret = generateSecret();
  await ApiClient.create({
    institutionId,
    name,
    keyId,
    secretHash: hashSecret(secret),
    active: true,
    permissions: ["CREATE_LEAD", "CREATE_APPLICATION", "READ_APPLICATION"],
  });

  console.log(`
  API credentials for ${institutionId} — shown once, store them now:

    Key ID        ${keyId}
    Secret        ${secret}
    Bearer token  ${keyId}.${secret}
`);
}

async function ensureResult(input: {
  institutionId: string;
  board: string;
  level: string;
  stream: string | null;
  academicYear: string;
  appeared: number;
  passed: number;
  averageScore?: number;
  highestScore?: number;
  bands?: Array<{ label: string; minPercentage: number; maxPercentage: number; count: number }>;
  toppers?: Array<{
    name: string;
    percentage: number;
    rank?: number;
    note?: string;
    consentAcknowledged: boolean;
  }>;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  publishedAt?: Date;
}) {
  const { institutionId, board, level, stream, academicYear } = input;
  const label = `${institutionId} ${board} ${level}${stream ? ` ${stream}` : ""} ${academicYear}`;

  // Matched against the schema's unique cycle index, not a synthetic key —
  // the same tuple that would trip the index on a duplicate insert.
  const existing = await Result.findOne({ institutionId, board, level, stream, academicYear }).lean();
  if (existing) {
    console.log(`  · ${label} already exists — skipped`);
    return;
  }

  await Result.create(input);
  console.log(`  · created ${label} (${input.status.toLowerCase()})`);
}

async function seedDemoRecords(institutionId: string) {
  const leadCount = await Lead.countDocuments({ institutionId });
  if (leadCount > 0) {
    console.log(`  · ${institutionId} already has records — demo data skipped`);
    return;
  }

  const samples = [
    { studentName: "Ananya Rao", parentName: "Suresh Rao", phone: "9845012345", classInterested: "Grade 6", status: "NEW" },
    { studentName: "Vikram Shetty", parentName: "Deepa Shetty", phone: "9845067890", classInterested: "Grade 8", status: "CONTACTED" },
    { studentName: "Fatima Khan", parentName: "Imran Khan", phone: "9900112233", classInterested: "Grade 1", status: "FOLLOW_UP" },
  ];

  for (const sample of samples) {
    const seq = await nextSequence(`${institutionId}:LEAD`);
    await Lead.create({
      ...sample,
      leadNumber: `${institutionId}-LD${String(seq).padStart(6, "0")}`,
      institutionId,
      source: "WEBSITE",
      email: "parent@example.com",
      message: "Requested a campus visit and fee structure.",
    });
  }

  const seq = await nextSequence(`${institutionId}:APPLICATION`);
  await Application.create({
    applicationNumber: `${institutionId}-APP-${String(seq).padStart(6, "0")}`,
    institutionId,
    academicYear: "2026-27",
    student: {
      firstName: "Ishaan",
      lastName: "Nayak",
      dateOfBirth: new Date("2014-03-22"),
      gender: "Male",
      bloodGroup: "O+",
    },
    studentFullName: "Ishaan Nayak",
    parent: {
      fatherName: "Ramesh Nayak",
      motherName: "Latha Nayak",
      phone: "9845098765",
      email: "ramesh.nayak@example.com",
    },
    address: {
      addressLine1: "42, Vijayanagar 2nd Stage",
      city: "Mysore",
      state: "Karnataka",
      pincode: "570017",
    },
    academic: { previousInstitution: "Little Flower School", previousClass: "Grade 6", previousPercentage: 82 },
    admission: { applyingFor: "Grade 7", admissionType: "REGULAR" },
    status: "UNDER_REVIEW",
    source: "WEBSITE",
  });

  console.log(`  · seeded ${samples.length} enquiries and 1 application for ${institutionId}`);
}

async function main() {
  const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/aem_platform";
  await mongoose.connect(uri);
  console.log(`Connected to ${uri}\n`);

  console.log("Institutions");
  await ensureInstitution({
    institutionId: "INS0001",
    institutionName: "Infinity School of Excellence",
    institutionType: "SCHOOL",
    address: "Plot 14, Hebbal Industrial Area",
    city: "Mysore",
    state: "Karnataka",
    pincode: "570016",
    phone: "8212540111",
    email: "admissions@infinityschool.edu.in",
    website: "https://infinityschool.edu.in",
    contactPerson: "Admissions Office",
    regionCode: "KA-MYS",
    tagline: "Learning that lasts",
    description:
      "A CBSE school in Mysore teaching Nursery through Grade 12, known for its science " +
      "and robotics programmes.",
    establishedYear: 1998,
    academic: {
      board: "CBSE",
      genderType: "CO_ED",
      classesOffered: ["Nursery", "Grade 1", "Grade 10", "Grade 12"],
    },
    management: {
      managementType: "TRUST",
      managementName: "Infinity Education Trust",
      principalName: "Dr. Latha Rao",
      headDesignation: "Principal",
    },
    facilities: [
      { code: "library", label: "Library", available: true, note: "12,000 titles" },
      { code: "science_lab", label: "Science Lab", available: true },
      { code: "transport", label: "Transport", available: true, note: "12 routes across Mysore" },
    ],
  });
  await ensureInstitution({
    institutionId: "INS0002",
    institutionName: "Intelligent Public School",
    institutionType: "SCHOOL",
    address: "5th Cross, Jayanagar",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560041",
    phone: "8026540222",
    email: "office@intelligentpublic.edu.in",
    website: "https://intelligentpublic.edu.in",
    contactPerson: "Front Office",
    regionCode: "KA-BLR",
    tagline: "Where every student thrives",
    description: "An ICSE school in Jayanagar, Bengaluru, from Kindergarten through Grade 10.",
    establishedYear: 2005,
    academic: {
      board: "ICSE",
      genderType: "CO_ED",
      classesOffered: ["Kindergarten", "Grade 1", "Grade 10"],
    },
    management: {
      managementType: "SOCIETY",
      principalName: "Mrs. Kavya Nair",
      headDesignation: "Principal",
    },
    facilities: [
      { code: "library", label: "Library", available: true },
      { code: "playground", label: "Playground", available: true },
    ],
  });

  console.log("\nUsers");
  await ensureUser({
    name: "Platform Administrator",
    email: process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@aemplatform.local",
    password: process.env.SEED_SUPER_ADMIN_PASSWORD ?? "ChangeMe!2026",
    role: "SUPER_ADMIN",
  });
  await ensureUser({
    name: "Infinity Admissions",
    email: "admin@infinityschool.edu.in",
    password: "Infinity!2026",
    role: "INSTITUTION_ADMIN",
    institutionId: "INS0001",
  });
  await ensureUser({
    name: "Intelligent Admissions",
    email: "admin@intelligentpublic.edu.in",
    password: "Intelligent!2026",
    role: "INSTITUTION_ADMIN",
    institutionId: "INS0002",
  });

  console.log("\nResults");
  await ensureResult({
    institutionId: "INS0001",
    board: "CBSE",
    level: "CLASS_10",
    stream: null,
    academicYear: "2025-26",
    appeared: 142,
    passed: 142,
    averageScore: 82.4,
    highestScore: 98.6,
    bands: [
      { label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 38 },
      { label: "75% to 89%", minPercentage: 75, maxPercentage: 89, count: 67 },
      { label: "60% to 74%", minPercentage: 60, maxPercentage: 74, count: 31 },
    ],
    toppers: [
      { name: "Priya Sharma", percentage: 98.6, rank: 1, note: "School topper", consentAcknowledged: true },
      { name: "Rahul Kumar", percentage: 97.8, rank: 2, consentAcknowledged: true },
      // Deliberately unconsented: proves the public API omits them.
      { name: "Vikram Nair", percentage: 96.4, rank: 3, consentAcknowledged: false },
    ],
    status: "PUBLISHED",
    publishedAt: new Date("2026-05-12T00:00:00.000Z"),
  });
  await ensureResult({
    institutionId: "INS0001",
    board: "CBSE",
    level: "CLASS_12",
    stream: "SCIENCE",
    academicYear: "2025-26",
    appeared: 96,
    passed: 95,
    averageScore: 79.8,
    highestScore: 97.2,
    bands: [
      { label: "90% and above", minPercentage: 90, maxPercentage: 100, count: 21 },
      { label: "75% to 89%", minPercentage: 75, maxPercentage: 89, count: 44 },
    ],
    toppers: [
      { name: "Ananya Rao", percentage: 97.2, rank: 1, note: "School topper", consentAcknowledged: true },
    ],
    status: "PUBLISHED",
    publishedAt: new Date("2026-05-20T00:00:00.000Z"),
  });

  console.log("\nAPI credentials");
  await ensureApiClient("INS0001", "Infinity School website");

  if (WITH_DEMO) {
    console.log("\nDemo records");
    await seedDemoRecords("INS0002");
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch(async (error) => {
  console.error("Seed failed:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
