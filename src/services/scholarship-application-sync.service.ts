import "server-only";
import { Types } from "mongoose";
import { ScholarshipApplication, Scholarship, PlatformConnection } from "@/models";
import { NotificationService } from "./notification.service";
import { afterResponse } from "@/lib/after-response";

export type HubApplicationPayload = {
  hubApplicationId: string;
  externalRef: string;
  scholarshipTitle: string;
  applicant: { name: string; email?: string; mobile?: string };
  answers: Record<string, unknown>;
  documents: { key: string; label: string; filename: string; contentType: string }[];
  status: string;
  applicationNo?: string;
  submittedAt?: string;
  withdrawnAt?: string;
  hubUpdatedAt: string;
};

export type IngestOutcome =
  | { kind: "SKIPPED"; reason: "NOT_CONNECTED" | "REF_MISMATCH" | "MALFORMED_REF" | "SCHOLARSHIP_NOT_FOUND" }
  | { kind: "STALE" }
  | { kind: "INSERTED"; id: string }
  | { kind: "UPDATED"; id: string };

function parseExternalRef(externalRef: string): { institutionId: string; scholarshipId: string } | null {
  const match = /^IDAP:([A-Za-z0-9]+):([a-f0-9]{24})$/.exec(externalRef);
  if (!match) return null;
  return { institutionId: match[1]!, scholarshipId: match[2]! };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

/**
 * The single idempotent ingestion core both the webhook receiver (Task 5)
 * and the reconciliation pull (Task 4) call. Keyed on
 * (institutionId, hubApplicationId). NEVER writes `reviewStatus`/
 * `assignedTo` past the first insert — those are IDAP-owned fields only the
 * dashboard (Task 7) changes.
 *
 * A withdrawn-on-Hub application whose reviewStatus is already e.g.
 * SHORTLISTED is left exactly that way — `hubStatus` and `reviewStatus`
 * simply coexist, by design (spec §6's failure matrix: "withdraw-after-
 * decision... the inbox surfaces 'withdrawn on Hub' prominently. No data
 * loss — both truths visible").
 */
export async function upsertFromHubPayload(payload: HubApplicationPayload): Promise<IngestOutcome> {
  const parsed = parseExternalRef(payload.externalRef);
  if (!parsed) return { kind: "SKIPPED", reason: "MALFORMED_REF" };
  const { institutionId, scholarshipId } = parsed;

  const connection = await PlatformConnection.findOne({ institutionId, platform: "SCHOLARSHIP_HUB" })
    .select("status")
    .lean();
  if (!connection || connection.status !== "CONNECTED") {
    return { kind: "SKIPPED", reason: "NOT_CONNECTED" };
  }

  const scholarship = await Scholarship.findOne({ _id: scholarshipId, institutionId })
    .select("listing.externalRef")
    .lean();
  if (!scholarship) return { kind: "SKIPPED", reason: "SCHOLARSHIP_NOT_FOUND" };
  if (scholarship.listing?.externalRef !== payload.externalRef) {
    return { kind: "SKIPPED", reason: "REF_MISMATCH" };
  }

  const hubUpdatedAt = new Date(payload.hubUpdatedAt);
  const existing = await ScholarshipApplication.findOne({
    institutionId,
    hubApplicationId: payload.hubApplicationId,
  })
    .select("hubUpdatedAt")
    .lean();

  if (existing && existing.hubUpdatedAt.getTime() >= hubUpdatedAt.getTime()) {
    return { kind: "STALE" };
  }

  const hubOwnedFields = {
    institutionId,
    scholarshipId: new Types.ObjectId(scholarshipId),
    externalRef: payload.externalRef,
    hubApplicationId: payload.hubApplicationId,
    applicant: payload.applicant,
    answers: payload.answers,
    documents: payload.documents,
    hubStatus: payload.status,
    ...(payload.applicationNo !== undefined ? { applicationNo: payload.applicationNo } : {}),
    ...(payload.submittedAt !== undefined ? { submittedAt: new Date(payload.submittedAt) } : {}),
    ...(payload.withdrawnAt !== undefined ? { withdrawnAt: new Date(payload.withdrawnAt) } : {}),
    hubUpdatedAt,
    lastSyncedAt: new Date(),
  };

  if (!existing) {
    try {
      const created = await ScholarshipApplication.create({ ...hubOwnedFields, reviewStatus: "NEW" });
      await afterResponse(() =>
        NotificationService.notifyNewHubApplication({
          institutionId,
          applicantName: payload.applicant.name,
          scholarshipTitle: payload.scholarshipTitle,
        }).catch((err: unknown) => console.error("[push] hub application notification failed", err)),
      );
      return { kind: "INSERTED", id: String(created._id) };
    } catch (error) {
      // Lost a race to a concurrent ingest of the same application — the
      // Hub payload is idempotent by construction, so falling through to
      // the update path below (rather than erroring) is correct, not just
      // tolerant.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  const updated = await ScholarshipApplication.findOneAndUpdate(
    { institutionId, hubApplicationId: payload.hubApplicationId },
    { $set: hubOwnedFields },
    { new: true, projection: { _id: 1 } },
  ).lean();
  if (!updated) throw new Error("scholarship-application sync: row vanished between insert and update");
  return { kind: "UPDATED", id: String(updated._id) };
}
