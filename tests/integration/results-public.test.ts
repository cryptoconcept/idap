import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { ResultService } from "@/services/result.service";
import { Institution, Result } from "@/models";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };
const cycle = {
  board: "CBSE" as const,
  level: "CLASS_10" as const,
  stream: null,
  academicYear: "2025-26",
  appeared: 142,
  passed: 140,
};

const call = async (institutionId: string, query = "") => {
  const { GET } = await import("@/app/api/public/[institutionId]/results/route");
  return GET(new Request(`http://localhost/api/public/${institutionId}/results${query}`) as never, {
    params: Promise.resolve({ institutionId }),
  } as never);
};

/** A publicly visible institution needs both flags, exactly like the profile endpoint. */
async function publishInstitution(institutionId: string, slug: string) {
  await Institution.updateOne(
    { institutionId },
    { $set: { slug, profileStatus: "PUBLISHED", active: true } },
  );
}

beforeAll(() => startTestDatabase("results-public"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await publishInstitution("INS0001", "infinity-school");
});

describe("public results endpoint", () => {
  it("returns a published cycle with a computed pass percentage", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    const response = await call("INS0001");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].passPercentage).toBe(98.6);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("is reachable by slug and returns the same payload", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    const { GET } = await import("@/app/api/public/institutions/[slug]/results/route");
    const response = await GET(
      new Request("http://localhost/api/public/institutions/infinity-school/results") as never,
      { params: Promise.resolve({ slug: "infinity-school" }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).results).toHaveLength(1);
  });

  it("hides a draft cycle without revealing that it exists", async () => {
    await ResultService.create("INS0001", cycle, actor);

    const payload = await (await call("INS0001")).json();
    expect(payload.results).toHaveLength(0);
  });

  it("hides an archived cycle", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);
    await ResultService.setStatus("INS0001", created.id, "archive", actor);

    expect((await (await call("INS0001")).json()).results).toHaveLength(0);
  });

  it("returns 404, never 403, for an institution that is not publicly visible", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    await Institution.updateOne({ institutionId: "INS0001" }, { $set: { active: false } });

    const response = await call("INS0001");
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for an institution whose profile is still a draft", async () => {
    await Institution.updateOne({ institutionId: "INS0001" }, { $set: { profileStatus: "DRAFT" } });

    expect((await call("INS0001")).status).toBe(404);
  });

  it("returns 404 for an institution that does not exist", async () => {
    expect((await call("INS9999")).status).toBe(404);
  });

  it("omits a topper who has not acknowledged consent", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: true },
        ],
      },
      actor,
    );
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    const body = JSON.stringify(await (await call("INS0001")).json());
    expect(body).toContain("Priya S");
    expect(body).toContain("Rahul K");
  });

  it("drops a topper on the very next read when consent is withdrawn after publication", async () => {
    const created = await ResultService.create(
      "INS0001",
      {
        ...cycle,
        toppers: [
          { name: "Priya S", percentage: 98.6, consentAcknowledged: true },
          { name: "Rahul K", percentage: 97.8, consentAcknowledged: true },
        ],
      },
      actor,
    );
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    // Consent withdrawn while the cycle stays PUBLISHED.
    await Result.updateOne(
      { _id: created.id, "toppers.name": "Rahul K" },
      { $set: { "toppers.$.consentAcknowledged": false } },
    );

    const body = JSON.stringify(await (await call("INS0001")).json());
    expect(body).toContain("Priya S");
    expect(body).not.toContain("Rahul K");
  });

  it("never leaks internal fields", async () => {
    const created = await ResultService.create("INS0001", cycle, actor);
    await ResultService.setStatus("INS0001", created.id, "publish", actor);

    const body = JSON.stringify(await (await call("INS0001")).json());
    expect(body).not.toContain("institutionId");
    expect(body).not.toContain("consentAcknowledged");
    expect(body).not.toContain("_id");
  });

  it("filters by academicYear, level and board", async () => {
    for (const year of ["2024-25", "2025-26"]) {
      const created = await ResultService.create("INS0001", { ...cycle, academicYear: year }, actor);
      await ResultService.setStatus("INS0001", created.id, "publish", actor);
    }

    expect((await (await call("INS0001", "?academicYear=2025-26")).json()).results).toHaveLength(1);
    expect((await (await call("INS0001", "?level=CLASS_10")).json()).results).toHaveLength(2);
    expect((await (await call("INS0001", "?board=CBSE")).json()).results).toHaveLength(2);
  });

  it("returns an empty list, not an error, for a filter that matches nothing", async () => {
    const response = await call("INS0001", "?academicYear=1999-00");

    expect(response.status).toBe(200);
    expect((await response.json()).results).toHaveLength(0);
  });

  it("rejects an unknown filter value as a validation error", async () => {
    expect((await call("INS0001", "?level=NOT_A_LEVEL")).status).toBe(400);
  });

  it("blocks a burst of reads from one IP once the limit is spent", async () => {
    const { PUBLIC_READ_RATE_LIMIT } = await import("@/lib/constants");

    let last = await call("INS0001");
    for (let i = 0; i < PUBLIC_READ_RATE_LIMIT.limit + 1; i += 1) {
      last = await call("INS0001");
    }

    expect(last.status).toBe(429);
    expect((await last.json()).error.code).toBe("RATE_LIMITED");
  });
});
