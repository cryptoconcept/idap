import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";

const doc = buildOpenApiDocument({ origin: "https://admissions.test" }) as {
  paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
  components: { schemas: Record<string, unknown> };
};

describe("OpenAPI — results", () => {
  it("documents the public results path by institution id", () => {
    expect(doc.paths["/api/public/{institutionId}/results"]?.get).toBeDefined();
  });

  it("documents the public results path by slug", () => {
    expect(doc.paths["/api/public/institutions/{slug}/results"]?.get).toBeDefined();
  });

  it("tags both as Website and declares them credential-free", () => {
    for (const path of [
      "/api/public/{institutionId}/results",
      "/api/public/institutions/{slug}/results",
    ]) {
      const operation = doc.paths[path]?.get;
      expect(operation?.tags).toContain("Website");
      expect(operation?.security).toEqual([]);
    }
  });

  it("defines the response schema", () => {
    expect(doc.components.schemas.PublicResultsResponse).toBeDefined();
  });

  it("never documents an institute-admin results route in the public spec", () => {
    const adminPaths = Object.keys(doc.paths).filter((path) =>
      path.startsWith("/api/settings/results"),
    );
    expect(adminPaths).toEqual([]);
  });
});
