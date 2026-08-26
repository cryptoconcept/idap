import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";

const doc = buildOpenApiDocument({ origin: "https://admissions.test" }) as {
  paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
  components: { schemas: Record<string, unknown> };
};

describe("OpenAPI — scholarships and offers", () => {
  it("documents the public scholarships paths", () => {
    expect(doc.paths["/api/public/{institutionId}/scholarships"]?.get).toBeDefined();
    expect(doc.paths["/api/public/institutions/{slug}/scholarships"]?.get).toBeDefined();
  });

  it("documents the public offers paths", () => {
    expect(doc.paths["/api/public/{institutionId}/offers"]?.get).toBeDefined();
    expect(doc.paths["/api/public/institutions/{slug}/offers"]?.get).toBeDefined();
  });

  it("tags all four as Website and declares them credential-free", () => {
    for (const path of [
      "/api/public/{institutionId}/scholarships",
      "/api/public/institutions/{slug}/scholarships",
      "/api/public/{institutionId}/offers",
      "/api/public/institutions/{slug}/offers",
    ]) {
      expect(doc.paths[path]?.get?.tags).toContain("Website");
      expect(doc.paths[path]?.get?.security).toEqual([]);
    }
  });

  it("defines the response schemas the paths reference", () => {
    expect(doc.components.schemas).toHaveProperty("PublicScholarshipsResponse");
    expect(doc.components.schemas).toHaveProperty("PublicScholarship");
    expect(doc.components.schemas).toHaveProperty("PublicOffersResponse");
    expect(doc.components.schemas).toHaveProperty("PublicOffer");
  });
});
