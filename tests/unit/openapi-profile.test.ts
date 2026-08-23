import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";

/**
 * Task 11: the OpenAPI document gains the two public profile endpoints
 * built in earlier tasks (by institution id, and by slug), and the product
 * name in the document itself moves from Lead Platform to I-DAP.
 */
describe("OpenAPI: public profile endpoints", () => {
  const generic = buildOpenApiDocument({ origin: "https://admissions.test" });
  const scoped = buildOpenApiDocument({
    origin: "https://admissions.test",
    institutionId: "INS0001",
    institutionName: "Infinity School of Excellence",
    slug: "infinity-school-mysore",
  });

  const paths = (doc: Record<string, unknown>) =>
    Object.keys(doc.paths as Record<string, unknown>);

  it("documents both profile paths, templated, when unscoped", () => {
    expect(paths(generic)).toContain("/api/public/{institutionId}/profile");
    expect(paths(generic)).toContain("/api/public/institutions/{slug}");
  });

  it("bakes the concrete institution id and its real slug into the profile paths when scoped", () => {
    expect(paths(scoped)).toContain("/api/public/INS0001/profile");
    expect(paths(scoped)).toContain("/api/public/institutions/infinity-school-mysore");
  });

  it("marks both new profile operations as requiring no credentials", () => {
    const scopedPaths = scoped.paths as Record<string, Record<string, { security?: unknown[] }>>;
    expect(scopedPaths["/api/public/INS0001/profile"].get.security).toEqual([]);
    expect(
      scopedPaths["/api/public/institutions/infinity-school-mysore"].get.security,
    ).toEqual([]);
  });

  it("titles the unscoped document I-DAP API", () => {
    expect((generic.info as { title: string }).title).toBe("I-DAP API");
  });
});
