import { describe, expect, it } from "vitest";
import { scholarshipListingState } from "@/lib/scholarship/listing-display";

/**
 * The UI convention gap: IDAP has no React component-test harness (no
 * @testing-library/react, no jsdom environment — `vitest.config.ts` runs
 * `environment: "node"` and only collects `tests/**\/*.test.ts`, never
 * `.test.tsx`). Rather than bolt one on for a single form, this tests the
 * pure display-logic helper `scholarship-actions.tsx` calls to decide the
 * Hub listing badge — the same convention `result-editor-logic.test.ts`
 * already uses for `blockingPublishReasons` (a helper behind
 * `result-editor.tsx`).
 *
 * The one fact worth a dedicated, mutation-distinguishing test: Task 8's
 * forward contract records a BLOCKED push as `remoteStatus: "published"` +
 * `hubId: ""` + a `blockedReason` (`recordBlockedReason` in
 * `scholarship-publish.service.ts`, for a push refused before the Hub ever
 * created a listing). A naive `remoteStatus === "closed" ? "closed" : "live"`
 * — the vacancy `isLive` shape this mirrors — would read that row as "Live",
 * which is a lie. `blockedReason` must be checked FIRST, i.e. be
 * authoritative over `remoteStatus`.
 */
describe("scholarshipListingState", () => {
  it("reads an ordinary push as live", () => {
    expect(scholarshipListingState({ remoteStatus: "published" })).toBe("live");
  });

  it("reads a withdrawn push as closed", () => {
    expect(scholarshipListingState({ remoteStatus: "closed" })).toBe("closed");
  });

  it("treats blockedReason as authoritative over a 'published' remoteStatus", () => {
    expect(
      scholarshipListingState({ remoteStatus: "published", blockedReason: "Moderation hold" }),
    ).toBe("blocked");
  });

  it("still reads blocked even over a 'closed' remoteStatus", () => {
    expect(
      scholarshipListingState({ remoteStatus: "closed", blockedReason: "Moderation hold" }),
    ).toBe("blocked");
  });

  it("ignores an empty-string blockedReason (nothing to show)", () => {
    expect(scholarshipListingState({ remoteStatus: "published", blockedReason: "" })).toBe("live");
  });
});
