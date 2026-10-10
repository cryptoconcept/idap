import { describe, it, expect } from "vitest";
import { hubStatusBadge, hubStatusIsClosed } from "@/lib/scholarship-applications/status-display";

describe("hubStatusBadge", () => {
  it("labels every HUB_APPLICATION_STATUSES value distinctly", () => {
    expect(hubStatusBadge("submitted").label).toBe("Submitted");
    expect(hubStatusBadge("under_review").label).toBe("Under review");
    expect(hubStatusBadge("shortlisted").label).toBe("Shortlisted");
    expect(hubStatusBadge("additional_info_required").label).toBe("More info requested");
    expect(hubStatusBadge("approved").label).toBe("Approved");
    expect(hubStatusBadge("rejected").label).toBe("Rejected");
    expect(hubStatusBadge("withdrawn").label).toBe("Withdrawn on Hub");
  });

  it("marks withdrawn with a distinct, attention-drawing variant", () => {
    expect(hubStatusBadge("withdrawn").variant).toBe("destructive");
    expect(hubStatusBadge("submitted").variant).not.toBe("destructive");
  });
});

describe("hubStatusIsClosed", () => {
  it("is true only for withdrawn — the one status the spec's failure matrix says must surface prominently", () => {
    expect(hubStatusIsClosed("withdrawn")).toBe(true);
    expect(hubStatusIsClosed("approved")).toBe(false);
    expect(hubStatusIsClosed("rejected")).toBe(false);
    expect(hubStatusIsClosed("submitted")).toBe(false);
  });
});
