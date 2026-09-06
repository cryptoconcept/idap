import { describe, it, expect } from "vitest";
import { PLATFORMS, PLATFORM_LABELS, SCHOLARSHIP_LISTING_REMOTE_STATUSES } from "@/lib/constants";

describe("SCHOLARSHIP_HUB registry", () => {
  it("registers the platform and label", () => {
    expect(PLATFORMS).toContain("SCHOLARSHIP_HUB");
    expect(PLATFORM_LABELS.SCHOLARSHIP_HUB).toBe("Scholarship Hub");
  });
  it("defines the listing remote statuses", () => {
    expect(SCHOLARSHIP_LISTING_REMOTE_STATUSES).toEqual(["published", "closed"]);
  });
});
