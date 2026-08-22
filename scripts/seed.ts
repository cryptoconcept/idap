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
import { hashPassword } from "../src/lib/security/password";
import { generateKeyId, generateSecret, hashSecret } from "../src/lib/security/tokens";

config({ path: ".env.local" });
config({ path: ".env" });

const WITH_DEMO = process.argv.includes("--demo");

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
}) {
  const existing = await Institution.findOne({ institutionId: input.institutionId }).lean();
  if (existing) {
    console.log(`  · ${input.institutionId} already exists — skipped`);
    return;
  }
  await Institution.create({ ...input, active: true });

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
