import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution, makeUser } from "../helpers/factories";
import { signSession, SESSION_COOKIE } from "@/lib/auth/session";
import { cookies } from "next/headers";
import { GET as listOffers, POST as createOffer } from "@/app/api/settings/offers/route";
import {
  DELETE as deleteOffer,
  GET as getOffer,
  PATCH as patchOffer,
} from "@/app/api/settings/offers/[offerId]/route";
import { POST as publishOffer } from "@/app/api/settings/offers/[offerId]/publish/route";
import { OfferService } from "@/services/offer.service";
import type { OfferKind } from "@/lib/constants";
import type { NextRequest } from "next/server";

function cookieRequest(init: { url?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(init.url ?? "http://localhost/api/settings/offers");
  const headers = new Headers();
  if (init.origin) headers.set("origin", init.origin);
  headers.set("host", "localhost");
  return {
    headers,
    nextUrl: url,
    url: url.toString(),
    json: async () => init.body ?? {},
  } as unknown as NextRequest;
}

async function signIn(
  institutionId: string,
  role: "INSTITUTION_ADMIN" | "COUNSELOR" | "FRONT_DESK",
  email: string,
) {
  const user = await makeUser(institutionId, role, email);
  const token = await signSession({
    sub: String(user._id),
    role,
    institutionId,
    name: user.name,
    email: user.email,
    v: 0,
  });
  (await cookies()).set(SESSION_COOKIE, token);
  return user;
}

const actor = { id: "6a887abd755db527bea51204", name: "Infinity Admissions" };

function input(
  overrides: { title?: string; kind?: OfferKind; value?: number } = {},
): { title: string; kind: OfferKind; value: number } {
  return {
    title: "Early bird",
    kind: "PERCENTAGE",
    value: 15,
    ...overrides,
  };
}

beforeAll(() => startTestDatabase("offer-routes"));
afterAll(stopTestDatabase);
beforeEach(async () => {
  await clearDatabase();
  await makeInstitution("INS0001");
  await makeInstitution("INS0002");
});
afterEach(async () => {
  (await cookies()).delete(SESSION_COOKIE);
});

describe("offer routes — admin CRUD over real HTTP", () => {
  it("GET (collection) returns only the calling institution's offers", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");
    await OfferService.create("INS0001", input(), actor);
    await OfferService.create(
      "INS0002",
      input({ title: "Other Institution Offer" }),
      actor,
    );

    const response = await listOffers();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.offers).toHaveLength(1);
    expect(payload.offers[0].title).toBe("Early bird");
  });

  it("GET (item) returns one; another institution's id returns 404", async () => {
    const created = await OfferService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const ownResponse = await getOffer(
      cookieRequest({ url: `http://localhost/api/settings/offers/${created.id}` }),
      { params: Promise.resolve({ offerId: created.id }) } as never,
    );
    expect(ownResponse.status).toBe(200);
    expect((await ownResponse.json()).offer.title).toBe("Early bird");

    (await cookies()).delete(SESSION_COOKIE);
    await signIn("INS0002", "INSTITUTION_ADMIN", "admin@intelligentpublic.edu.in");

    const foreignResponse = await getOffer(
      cookieRequest({ url: `http://localhost/api/settings/offers/${created.id}` }),
      { params: Promise.resolve({ offerId: created.id }) } as never,
    );
    expect(foreignResponse.status).toBe(404);
  });

  it("POST creates one and returns 201", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createOffer(
      cookieRequest({ body: input(), origin: "http://localhost" }),
    );
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.offer.title).toBe("Early bird");
    expect(payload.offer.status).toBe("DRAFT");
  });

  it("POST without a same-origin header is refused — the write never lands", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createOffer(
      cookieRequest({ body: input(), origin: "http://evil.example" }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(600);

    // The status code alone proves nothing if the handler wrote anyway before
    // returning it — so also assert the row was never created.
    const after = await OfferService.list("INS0001");
    expect(after).toHaveLength(0);
  });

  it("PATCH updates one", async () => {
    const created = await OfferService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await patchOffer(
      cookieRequest({
        url: `http://localhost/api/settings/offers/${created.id}`,
        body: { value: 25 },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ offerId: created.id }) } as never,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).offer.value).toBe(25);
  });

  it("PATCH on another institution's offer returns 404", async () => {
    const created = await OfferService.create("INS0001", input(), actor);
    await signIn("INS0002", "INSTITUTION_ADMIN", "admin@intelligentpublic.edu.in");

    const response = await patchOffer(
      cookieRequest({
        url: `http://localhost/api/settings/offers/${created.id}`,
        body: { value: 25 },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ offerId: created.id }) } as never,
    );
    expect(response.status).toBe(404);
  });

  it("DELETE removes one", async () => {
    const created = await OfferService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await deleteOffer(
      cookieRequest({
        url: `http://localhost/api/settings/offers/${created.id}`,
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ offerId: created.id }) } as never,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).deleted).toBe(true);

    const remaining = await OfferService.list("INS0001");
    expect(remaining).toHaveLength(0);
  });

  it("POST …/publish with { action: \"publish\" } publishes", async () => {
    const created = await OfferService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await publishOffer(
      cookieRequest({
        url: `http://localhost/api/settings/offers/${created.id}/publish`,
        body: { action: "publish" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ offerId: created.id }) } as never,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).offer.status).toBe("PUBLISHED");
  });

  it("POST …/publish with { action: \"nonsense\" } returns a validation error", async () => {
    const created = await OfferService.create("INS0001", input(), actor);
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await publishOffer(
      cookieRequest({
        url: `http://localhost/api/settings/offers/${created.id}/publish`,
        body: { action: "nonsense" },
        origin: "http://localhost",
      }),
      { params: Promise.resolve({ offerId: created.id }) } as never,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("POST with a PERCENTAGE value over 100 returns a validation error on the route path", async () => {
    await signIn("INS0001", "INSTITUTION_ADMIN", "admin@infinityschool.edu.in");

    const response = await createOffer(
      cookieRequest({
        body: { title: "X", kind: "PERCENTAGE", value: 150 },
        origin: "http://localhost",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");

    const after = await OfferService.list("INS0001");
    expect(after).toHaveLength(0);
  });
});
