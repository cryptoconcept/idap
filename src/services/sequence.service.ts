import "server-only";
import { connectToDatabase } from "@/lib/db/mongoose";
import { Counter } from "@/models";

async function nextSequence(scope: string): Promise<number> {
  await connectToDatabase();
  const counter = await Counter.findOneAndUpdate(
    { _id: scope },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return counter?.seq ?? 1;
}

/** `INS0001-LD000001` */
export async function generateLeadNumber(institutionId: string): Promise<string> {
  const seq = await nextSequence(`${institutionId}:LEAD`);
  return `${institutionId}-LD${String(seq).padStart(6, "0")}`;
}

/** `INS0001-APP-000001` */
export async function generateApplicationNumber(institutionId: string): Promise<string> {
  const seq = await nextSequence(`${institutionId}:APPLICATION`);
  return `${institutionId}-APP-${String(seq).padStart(6, "0")}`;
}

/** `INS0001`, `INS0002`, ... allocated platform-wide. */
export async function generateInstitutionId(): Promise<string> {
  const seq = await nextSequence("PLATFORM:INSTITUTION");
  return `INS${String(seq).padStart(4, "0")}`;
}

/** Keeps the platform counter ahead of any manually assigned institution id. */
export async function reserveInstitutionId(institutionId: string): Promise<void> {
  const numeric = Number(institutionId.replace(/^INS/i, ""));
  if (!Number.isFinite(numeric)) return;
  await connectToDatabase();
  await Counter.updateOne(
    { _id: "PLATFORM:INSTITUTION", seq: { $lt: numeric } },
    { $set: { seq: numeric } },
    { upsert: true },
  ).catch(() => undefined);
}
