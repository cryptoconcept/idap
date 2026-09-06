import type { ScholarshipListingDTO } from "@/services/scholarship-publish.service";

/**
 * The three states `scholarship-actions.tsx`'s listing panel ever needs to
 * tell apart, mirroring `vacancies-section.tsx`'s `isLive`/`ListingPanel`
 * badge but for Scholarship Hub's simpler (no claim/conflict) contract.
 *
 * `blockedReason` is AUTHORITATIVE over `remoteStatus` — a BLOCKED push can
 * be recorded with `remoteStatus: "published"` and `hubId: ""`
 * (`scholarship-publish.service.ts`'s `recordBlockedReason`, for a push
 * refused before Scholarship Hub ever created a listing), so a listing
 * carrying a `blockedReason` must never read as "Live", whatever
 * `remoteStatus` says. This is checked first, unconditionally.
 */
export type ScholarshipListingState = "live" | "closed" | "blocked";

export function scholarshipListingState(
  listing: Pick<ScholarshipListingDTO, "remoteStatus" | "blockedReason">,
): ScholarshipListingState {
  if (listing.blockedReason) return "blocked";
  return listing.remoteStatus === "closed" ? "closed" : "live";
}
