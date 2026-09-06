import { describe, it, expect } from "vitest";
import type { PlatformAdapter, ScholarshipPushResult, SyncSourceData } from "@/lib/connectors/types";

describe("scholarship connector types", () => {
  it("allows an adapter to declare scholarship push methods", () => {
    const partial: Pick<PlatformAdapter, "upsertScholarship" | "withdrawScholarship"> = {
      async upsertScholarship() { return { kind: "OK", hubId: "h", slug: "s", remoteStatus: "published" } as ScholarshipPushResult; },
      async withdrawScholarship() { return { kind: "NOT_FOUND" } as ScholarshipPushResult; },
    };
    expect(typeof partial.upsertScholarship).toBe("function");
  });
  it("allows a scholarships worklist on SyncSourceData", () => {
    const s: Pick<SyncSourceData, "scholarships"> = { scholarships: [] };
    expect(s.scholarships).toEqual([]);
  });
});
