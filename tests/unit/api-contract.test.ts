import { describe, expect, it } from "vitest";
import { z } from "zod";
import { handleApiError, jsonSuccess } from "@/lib/api/response";
import { AppError } from "@/lib/api/errors";
import { buildOpenApiDocument } from "@/lib/api/openapi";

async function body(response: Response) {
  return response.json() as Promise<Record<string, never>>;
}

describe("response envelope", () => {
  it("wraps success with the documented shape", async () => {
    const response = jsonSuccess({ leadNumber: "INS0001-LD000001" }, { status: 201 });
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ success: true, leadNumber: "INS0001-LD000001" });
  });

  it("turns a Zod failure into a field-level validation error", async () => {
    const schema = z.object({ phone: z.string() });
    const result = schema.safeParse({});
    const response = handleApiError(result.error);

    expect(response.status).toBe(400);
    const payload = (await body(response)) as unknown as {
      success: boolean;
      error: { code: string; message: string; details: { field: string }[] };
    };
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
    expect(payload.error.message).toMatch(/^phone: /);
    expect(payload.error.details[0].field).toBe("phone");
  });

  it("preserves an AppError's code and status", async () => {
    const response = handleApiError(new AppError("NOT_FOUND", "Application not found"));
    expect(response.status).toBe(404);
    const payload = (await body(response)) as unknown as { error: { code: string } };
    expect(payload.error.code).toBe("NOT_FOUND");
  });

  it("maps a duplicate-key write to CONFLICT", async () => {
    const response = handleApiError({ code: 11000, message: "E11000 duplicate key" });
    expect(response.status).toBe(409);
  });

  it("never leaks an unexpected error's message to the caller", async () => {
    const leaky = new Error("connect ECONNREFUSED 127.0.0.1:27017 db=secrets");
    const response = handleApiError(leaky);

    expect(response.status).toBe(500);
    const raw = JSON.stringify(await body(response));
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("27017");
    expect(raw).toContain("Something went wrong");
  });

  it("attaches rate-limit headers when given them", () => {
    const response = handleApiError(new AppError("RATE_LIMITED", "slow down"), {
      "Retry-After": "42",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
  });
});

describe("OpenAPI document", () => {
  const generic = buildOpenApiDocument({ origin: "https://admissions.test" });
  const scoped = buildOpenApiDocument({
    origin: "https://admissions.test",
    institutionId: "INS0042",
    institutionName: "Test College",
  });

  const paths = (doc: Record<string, unknown>) =>
    Object.keys(doc.paths as Record<string, unknown>);

  it("declares OpenAPI 3.1 and this deployment as the server", () => {
    expect(generic.openapi).toBe("3.1.0");
    expect((generic.servers as { url: string }[])[0].url).toBe("https://admissions.test");
  });

  it("templates the institution when unscoped", () => {
    expect(paths(generic)).toContain("/api/public/{institutionId}/leads");
  });

  it("bakes the institution into every path when scoped", () => {
    // An agent handed this file should have nothing left to substitute.
    expect(paths(scoped)).toContain("/api/public/INS0042/leads");
    expect(paths(scoped)).toContain("/api/public/INS0042/applications");
    expect(paths(scoped).some((path) => path.includes("{institutionId}"))).toBe(false);
  });

  it("marks the browser-safe operations as requiring no credentials", () => {
    const publicPaths = paths(scoped).filter((path) => path.startsWith("/api/public"));
    expect(publicPaths).toHaveLength(3);

    for (const path of publicPaths) {
      const operations = (scoped.paths as Record<string, Record<string, { security?: unknown[]; tags?: string[] }>>)[path];
      for (const method of ["get", "post"]) {
        const operation = operations[method];
        if (!operation) continue;
        expect(operation.security).toEqual([]);
        expect(operation.tags).toContain("Website");
      }
    }
  });

  it("keeps the credentialed endpoints under the default security scheme", () => {
    const operation = (
      scoped.paths as Record<string, Record<string, { security?: unknown[]; tags?: string[] }>>
    )["/api/v1/leads"].post;
    expect(operation.security).toBeUndefined();
    expect(operation.tags).toContain("Server to server");
  });

  it("tells the reader not to put a secret in the browser", () => {
    const description = (scoped.info as { description: string }).description;
    expect(description).toMatch(/never put an api key or secret in browser javascript/i);
    expect(description).toContain("/api/public/INS0042/leads");
  });

  it("documents every error code the API can return", () => {
    const schema = (
      scoped.components as {
        schemas: { ErrorResponse: { properties: { error: { properties: { code: { enum: string[] } } } } } };
      }
    ).schemas.ErrorResponse;
    expect(schema.properties.error.properties.code.enum).toEqual([
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "RATE_LIMITED",
      "INTERNAL_ERROR",
    ]);
  });

  it("resolves every internal $ref", () => {
    const schemas = Object.keys(
      (scoped.components as { schemas: Record<string, unknown> }).schemas,
    );
    const refs = [...JSON.stringify(scoped).matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g)].map(
      (match) => match[1],
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of new Set(refs)) {
      expect(schemas).toContain(ref);
    }
  });
});
