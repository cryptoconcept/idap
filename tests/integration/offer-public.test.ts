import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeProfiledInstitution } from "../helpers/factories";
import { GET as getByInstitutionId } from "@/app/api/public/[institutionId]/offers/route";
import { GET as getBySlug } from "@/app/api/public/institutions/[slug]/offers/route";
import { Offer } from "@/models";
import { OfferService } from "@/services/offer.service";
import type { OfferKind } from "@/lib/constants";

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

function input(
  overrides: { title?: string } = {},
): { title: string; kind: OfferKind; value: number } {
  return {
    title: "Early bird",
    kind: "PERCENTAGE",
    value: 15,
    ...overrides,
  };
}

beforeAll(async () => {
  await startTestDatabase("offer-public");
  await Offer.syncIndexes();
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

describe("GET /api/public/:institutionId/offers", () => {
  it("returns a published offer by institutionId", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create("INS0001", input(), actor);
    await OfferService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/offers"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.offers).toHaveLength(1);
    expect(payload.offers[0].title).toBe("Early bird");
  });

  it("returns a published offer by slug", async () => {
    await makeProfiledInstitution("INS0001", {
      profileStatus: "PUBLISHED",
      slug: "infinity-school",
    });
    const created = await OfferService.create("INS0001", input(), actor);
    await OfferService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getBySlug(
      new Request("http://localhost/api/public/institutions/infinity-school/offers"),
      { params: Promise.resolve({ slug: "infinity-school" }) } as never,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.offers).toHaveLength(1);
    expect(payload.offers[0].title).toBe("Early bird");
  });

  it("excludes a DRAFT offer", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    await OfferService.create("INS0001", input(), actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/offers"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).offers).toEqual([]);
  });

  it("404s for an institution whose profileStatus is DRAFT", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "DRAFT" });
    const created = await OfferService.create("INS0001", input(), actor);
    await OfferService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/offers"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("404s for an inactive institution", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED", active: false });
    const created = await OfferService.create("INS0001", input(), actor);
    await OfferService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/offers"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("404s for a nonexistent institution", async () => {
    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS9999/offers"),
      { params: Promise.resolve({ institutionId: "INS9999" }) } as never,
    );

    expect(response.status).toBe(404);
  });

  it("carries no institutionId, status, or _id on any row", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });
    const created = await OfferService.create("INS0001", input(), actor);
    await OfferService.setStatus("INS0001", created.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/offers"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    const payload = await response.json();
    expect(payload.offers).toHaveLength(1);
    const row = payload.offers[0];
    expect(row.institutionId).toBeUndefined();
    expect(row.status).toBeUndefined();
    expect(row._id).toBeUndefined();
  });

  it("excludes an expired published offer while keeping a non-expired one visible", async () => {
    await makeProfiledInstitution("INS0001", { profileStatus: "PUBLISHED" });

    const expired = await OfferService.create(
      "INS0001",
      input({ title: "Expired Early Bird" }),
      actor,
    );
    await OfferService.setStatus("INS0001", expired.id, "publish", actor);
    await Offer.updateOne(
      { _id: expired.id },
      { $set: { validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    );

    const current = await OfferService.create(
      "INS0001",
      input({ title: "Still Open" }),
      actor,
    );
    await OfferService.setStatus("INS0001", current.id, "publish", actor);

    const response = await getByInstitutionId(
      new Request("http://localhost/api/public/INS0001/offers"),
      { params: Promise.resolve({ institutionId: "INS0001" }) } as never,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.offers).toHaveLength(1);
    expect(payload.offers[0].title).toBe("Still Open");
  });
});
