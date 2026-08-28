import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { PlatformConnection, PlatformCredential, Vacancy } from "@/models";
import type { VacancyDoc } from "@/models";
import { encryptCredential } from "@/lib/security/credentials";
import { ConnectorAuthError } from "@/lib/connectors/types";
import { VacancyPublishService, type VacancyPublishOutcome } from "@/services/vacancy-publish.service";

// ---------------------------------------------------------------------------
// Why this file stubs `fetch` rather than registering a fake adapter
//
// `connection-service.test.ts` swaps in a fake adapter because what it tests is
// the service's own bookkeeping around whatever the adapter returns. This file
// tests the opposite thing: WHICH endpoint gets called, with WHICH credential,
// and — three times over — that no call is made at all. A fake adapter would
// let the service pick the wrong contract and still pass, because the fake has
// no endpoints. Stubbing the global `fetch` keeps the real eduFleet adapter,
// the real `createConnectorHttp` and the real URL/Authorization construction in
// the path, so the contract-selection assertions are made against the actual
// wire request — and "no HTTP call" means no HTTP call, not "no adapter call".
// ---------------------------------------------------------------------------

const PLATFORM_KEY = "ef_pkey_test_platform";
const GRANT_TOKEN = "ef_pgrant_test_school";
const BASE_URL = "https://api.edufleet.test";
const VALID_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
const actor = { id: "6a8880f3446c577c470cd06c", name: "Institution Admin" };

type FetchCall = { url: string; method: string; token: string; body: Record<string, unknown> };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs `fetch` with one queued response per call, in order. */
function stubFetch(...responses: Response[]) {
  const mock = vi.fn();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Reads one recorded request back in the shape the assertions care about. */
function callAt(mock: ReturnType<typeof vi.fn>, index: number): FetchCall {
  const [url, init] = mock.mock.calls[index] as [
    string,
    { method: string; headers: Record<string, string>; body?: string },
  ];
  return {
    url: String(url),
    method: init.method,
    token: init.headers.Authorization,
    body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
  };
}

async function makeCredential(overrides: Record<string, unknown> = {}) {
  return PlatformCredential.create({
    platform: "EDUFLEET",
    keyEncrypted: encryptCredential(PLATFORM_KEY),
    baseUrl: BASE_URL,
    active: true,
    ...overrides,
  });
}

/** A CONNECTED eduFleet connection holding a school grant — Contract Two. */
async function makeConnectedGrant(institutionId: string, overrides: Record<string, unknown> = {}) {
  return PlatformConnection.create({
    institutionId,
    platform: "EDUFLEET",
    status: "CONNECTED",
    externalRef: institutionId,
    grantTokenEncrypted: encryptCredential(GRANT_TOKEN),
    scopes: ["jobs:write"],
    ...overrides,
  });
}

async function makeVacancy(institutionId: string, overrides: Record<string, unknown> = {}) {
  return Vacancy.create({
    institutionId,
    title: "Mathematics Teacher",
    subject: "Mathematics",
    description: "Teach Mathematics to Grades 8-10.",
    salaryMin: 30000,
    salaryMax: 50000,
    experienceRequired: 3,
    status: "OPEN",
    ...overrides,
  });
}

/** The stored `listing` sub-document, read back from the database. */
async function storedListing(vacancyId: string) {
  const row = await Vacancy.findById(vacancyId).lean<VacancyDoc>();
  return row?.listing ?? undefined;
}

/** Asserts the outcome arm and narrows it, so a test can read the arm's own
 *  fields without a cast. */
function expectOutcome<K extends VacancyPublishOutcome["status"]>(
  outcome: VacancyPublishOutcome,
  status: K,
): Extract<VacancyPublishOutcome, { status: K }> {
  expect(outcome.status).toBe(status);
  return outcome as Extract<VacancyPublishOutcome, { status: K }>;
}

beforeAll(() => startTestDatabase("vacancy-publish-service"));
afterAll(stopTestDatabase);

beforeEach(async () => {
  await clearDatabase();
  process.env.IDAP_CREDENTIAL_KEY = VALID_VAULT_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Rule 1 — contract selection
// ---------------------------------------------------------------------------

describe("rule 1: contract selection", () => {
  it("MUTATION-DISTINGUISHING: a CONNECTED institution with a grant publishes under Contract Two", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    await makeConnectedGrant("INS0001");
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(201, { jobId: "ef-job-1", externalJobId: String(vacancy._id), status: "active" }),
    );

    const outcome = await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = callAt(fetchMock, 0);
    expect(call.url).toBe(`${BASE_URL}/api/partner/school/jobs`);
    expect(call.method).toBe("POST");
    // The school's own grant, never the platform key: a platform key cannot
    // post as a specific school.
    expect(call.token).toBe(`Bearer ${GRANT_TOKEN}`);
    // Contract Two accepts neither of these; the grant already identifies the school.
    expect(call.body.institutionName).toBeUndefined();
    expect(call.body.state).toBeUndefined();
    // ...but it does require a location, or the write 400s and burns a unit.
    expect(call.body.city).toBe("Mysore");

    expect(outcome.status).toBe("PUSHED");
    expect((await storedListing(String(vacancy._id)))?.contract).toBe("SCHOOL_POSTED");
  });

  it("falls back to Contract One with the platform key when no connection exists", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(201, {
        jobId: "ef-job-2",
        externalJobId: String(vacancy._id),
        status: "active",
        claimStatus: "unclaimed",
      }),
    );

    await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    const call = callAt(fetchMock, 0);
    expect(call.url).toBe(`${BASE_URL}/api/partner/jobs`);
    expect(call.token).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(call.body.institutionName).toBe("INS0001 Institute");
    expect(call.body.city).toBe("Mysore");
    expect(call.body.externalJobId).toBe(String(vacancy._id));

    const listing = await storedListing(String(vacancy._id));
    expect(listing?.contract).toBe("AGGREGATED");
    expect(listing?.jobId).toBe("ef-job-2");
    expect(listing?.claimState).toBe("unclaimed");
  });

  it("uses Contract One when a connection exists but is not CONNECTED, and when it holds no grant", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await makeCredential();
    // Approved-but-not-redeemed: a row exists, no grant was ever issued.
    await PlatformConnection.create({
      institutionId: "INS0001",
      platform: "EDUFLEET",
      status: "AWAITING_APPROVAL",
      externalRef: "INS0001",
    });
    // Connected, but the ciphertext is gone (the school revoked and the row
    // was cleaned up) — "CONNECTED with a grant" is two conditions, not one.
    await makeConnectedGrant("INS0002", { grantTokenEncrypted: undefined });

    const first = await makeVacancy("INS0001");
    const second = await makeVacancy("INS0002");
    const fetchMock = stubFetch(
      jsonResponse(201, { jobId: "ef-job-3", status: "active" }),
      jsonResponse(201, { jobId: "ef-job-4", status: "active" }),
    );

    await VacancyPublishService.publish("INS0001", String(first._id), actor);
    await VacancyPublishService.publish("INS0002", String(second._id), actor);

    expect(callAt(fetchMock, 0).url).toBe(`${BASE_URL}/api/partner/jobs`);
    expect(callAt(fetchMock, 0).token).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(callAt(fetchMock, 1).url).toBe(`${BASE_URL}/api/partner/jobs`);
    expect(callAt(fetchMock, 1).token).toBe(`Bearer ${PLATFORM_KEY}`);
  });

  it("reads the connection for THIS institution only", async () => {
    // A neighbouring institution's grant must never decide this one's contract.
    await makeInstitution("INS0001");
    await makeCredential();
    await makeConnectedGrant("INS0002");
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch(jsonResponse(201, { jobId: "ef-job-5", status: "active" }));

    await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(callAt(fetchMock, 0).url).toBe(`${BASE_URL}/api/partner/jobs`);
    expect(callAt(fetchMock, 0).token).toBe(`Bearer ${PLATFORM_KEY}`);
  });
});

describe("rule 1: an existing listing pins the contract", () => {
  it("MUTATION-DISTINGUISHING: a listing already created under Contract One is patched under Contract One, grant or no grant", async () => {
    // The school connected AFTER publishing. eduFleet fixes a job's origin at
    // creation and Contract Two's PATCH can only see `school_posted` rows, so
    // re-selecting on today's connection would send this listing to an
    // endpoint that cannot find it.
    await makeInstitution("INS0001");
    await makeCredential();
    await makeConnectedGrant("INS0001");
    const vacancy = await makeVacancy("INS0001", {
      listing: {
        jobId: "ef-job-6",
        contract: "AGGREGATED",
        lastPushedAt: new Date("2026-08-01T00:00:00.000Z"),
        claimState: "unclaimed",
      },
    });
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "ef-job-6", status: "active" }));

    await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    const call = callAt(fetchMock, 0);
    expect(call.url).toBe(`${BASE_URL}/api/partner/jobs/${String(vacancy._id)}`);
    expect(call.token).toBe(`Bearer ${PLATFORM_KEY}`);
    expect((await storedListing(String(vacancy._id)))?.contract).toBe("AGGREGATED");
  });

  it("refuses in words when a school-posted listing outlives the grant that made it", async () => {
    // Published under the school's own grant, then disconnected. Only a grant
    // can reach that listing, so say so — the adapter would otherwise throw
    // "requires a grant token" into a generic 502.
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", {
      listing: {
        jobId: "ef-job-7",
        contract: "SCHOOL_POSTED",
        lastPushedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    const fetchMock = stubFetch();

    await expect(
      VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
    ).rejects.toThrow(/reconnect to eduFleet Exchange/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — the city gate at publish
// ---------------------------------------------------------------------------

describe("rule 2: the city gate", () => {
  it("MUTATION-DISTINGUISHING: refuses a cityless institution with the exact message, before any HTTP call", async () => {
    await makeInstitution("INS0001", { city: undefined });
    await makeCredential();
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch();

    await expect(VacancyPublishService.publish("INS0001", String(vacancy._id), actor)).rejects.toThrow(
      "Add a city to the institution profile before publishing to eduFleet Exchange",
    );

    // Not merely "an error was returned": `preflight` would also refuse this
    // push, with its own wording. Asserting the exact string is what makes
    // deleting the gate fail this test rather than quietly re-route it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedListing(String(vacancy._id))).toBeUndefined();
  });

  it("treats a whitespace-only city as no city at all", async () => {
    await makeInstitution("INS0001", { city: "   " });
    await makeCredential();
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch();

    await expect(VacancyPublishService.publish("INS0001", String(vacancy._id), actor)).rejects.toThrow(
      "Add a city to the institution profile before publishing to eduFleet Exchange",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — preflight is the quota shield
// ---------------------------------------------------------------------------

describe("rule 3: preflight before every field push", () => {
  it("MUTATION-DISTINGUISHING: a vacancy preflight refuses never reaches the wire", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    // Written straight to the model: the Zod layer refuses an inverted pair,
    // but a stored row can still carry one (two single-bound patches, an
    // import, a direct write), and eduFleet spends the write unit BEFORE it
    // validates — so this is exactly the push that must never leave IDAP.
    const vacancy = await makeVacancy("INS0001", { salaryMin: 90000, salaryMax: 10000 });
    // A response eduFleet would happily have given — queued precisely so it
    // can go unused. If the shield were moved to AFTER the call, the refusal
    // below would still be a VALIDATION_ERROR carrying the same reason, and
    // only the two assertions after it would notice that a write unit had
    // already been spent and a listing already written.
    const fetchMock = stubFetch(jsonResponse(201, { jobId: "ef-job-never", status: "active" }));

    await expect(
      VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: ["The salary minimum cannot exceed the maximum"],
    });

    // The whole point of the rule: the refusal costs nothing because nothing
    // was sent. A shield that fires after the money is spent is not a shield.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedListing(String(vacancy._id))).toBeUndefined();
  });

  it("collects every preflight reason in one pass rather than one round trip per fix", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", {
      salaryMin: 90000,
      salaryMax: 10000,
      experienceRequired: 4,
    });
    await Vacancy.collection.updateOne(
      { _id: vacancy._id },
      { $set: { experienceRequired: -1 } },
    );
    const fetchMock = stubFetch();

    await expect(
      VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
    ).rejects.toMatchObject({
      details: [
        "The salary minimum cannot exceed the maximum",
        "Experience required cannot be negative",
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — only OPEN vacancies publish
// ---------------------------------------------------------------------------

describe("rule 4: only OPEN vacancies publish", () => {
  it("refuses a DRAFT vacancy without making any HTTP call", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", { status: "DRAFT" });
    const fetchMock = stubFetch();

    await expect(
      VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
    ).rejects.toThrow("Set this vacancy to Open before publishing it to eduFleet Exchange");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedListing(String(vacancy._id))).toBeUndefined();
  });

  it("MUTATION-DISTINGUISHING: pushes a close — not a create — when the vacancy is FILLED, addressed the way Contract One addresses jobs", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", {
      status: "FILLED",
      listing: {
        jobId: "ef-job-10",
        contract: "AGGREGATED",
        lastPushedAt: new Date("2026-08-01T00:00:00.000Z"),
        claimState: "unclaimed",
      },
    });
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "ef-job-10", status: "closed" }));

    const outcome = await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("CLOSED");
    const call = callAt(fetchMock, 0);
    expect(call.method).toBe("PATCH");
    // Contract One addresses a job by its externalJobId — IDAP's own vacancy
    // id — NOT by eduFleet's Mongo id (`partner-jobs.ts:updatePartnerJob`).
    expect(call.url).toBe(`${BASE_URL}/api/partner/jobs/${String(vacancy._id)}`);
    // A close carries `{status:"closed"}` and nothing else: Contract Two's
    // PATCH short-circuits on `status` and silently discards the rest.
    expect(call.body).toEqual({ status: "closed" });
  });

  it("closes a CLOSED vacancy's listing too", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    await makeConnectedGrant("INS0001");
    const vacancy = await makeVacancy("INS0001", {
      status: "CLOSED",
      listing: {
        jobId: "ef-job-11",
        contract: "SCHOOL_POSTED",
        lastPushedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "ef-job-11", status: "closed" }));

    const outcome = await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("CLOSED");
    // Contract Two addresses a job by eduFleet's own id (`updateSchoolJob`
    // queries `{_id: jobId}`), which is the opposite of Contract One.
    expect(callAt(fetchMock, 0).url).toBe(`${BASE_URL}/api/partner/school/jobs/ef-job-11`);
    expect(callAt(fetchMock, 0).token).toBe(`Bearer ${GRANT_TOKEN}`);
  });

  it("publishing a FILLED vacancy that was never listed closes nothing and calls nothing", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", { status: "FILLED" });
    const fetchMock = stubFetch();

    const outcome = await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("NOT_LISTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("patches an already-published OPEN vacancy instead of creating a second listing", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", {
      listing: {
        jobId: "ef-job-12",
        contract: "AGGREGATED",
        lastPushedAt: new Date("2026-08-01T00:00:00.000Z"),
        claimState: "unclaimed",
      },
    });
    const fetchMock = stubFetch(
      jsonResponse(200, { jobId: "ef-job-12", title: "Mathematics Teacher", status: "active" }),
    );

    const outcome = await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("PUSHED");
    const call = callAt(fetchMock, 0);
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe(`${BASE_URL}/api/partner/jobs/${String(vacancy._id)}`);
    // Only what eduFleet's PATCH actually applies. `status` in particular is
    // structurally absent — `patchJob` throws on it, and Contract Two would
    // silently discard every other field in the same body.
    expect(Object.keys(call.body).sort()).toEqual([
      "description",
      "experienceRequired",
      "salaryMax",
      "salaryMin",
      "title",
    ]);
    // The listing keeps the id eduFleet issued; only the push time moves.
    const listing = await storedListing(String(vacancy._id));
    expect(listing?.jobId).toBe("ef-job-12");
    expect(listing?.lastPushedAt?.toISOString()).not.toBe("2026-08-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — BLOCKED is recorded, never latched
// ---------------------------------------------------------------------------

describe("rule 5: BLOCKED is recorded, never latched", () => {
  it("MUTATION-DISTINGUISHING: a 403 records blockedReason and leaves the rest of the listing intact", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const pushedAt = new Date("2026-08-01T00:00:00.000Z");
    const vacancy = await makeVacancy("INS0001", {
      listing: { jobId: "ef-job-20", contract: "AGGREGATED", lastPushedAt: pushedAt, claimState: "unclaimed" },
    });
    const fetchMock = stubFetch(
      jsonResponse(403, {
        error: "This listing has been claimed by the school and can no longer be edited by a partner key",
        reason: "claimed",
      }),
    );

    const outcome = await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("BLOCKED");
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried — the unit is already spent
    const listing = await storedListing(String(vacancy._id));
    expect(listing?.blockedReason).toContain("claimed");
    // Everything else survives: two of eduFleet's four 403 triggers
    // (claim_pending, hiddenPendingReview) reverse on their own, so the
    // listing must stay usable rather than being latched as dead.
    expect(listing?.jobId).toBe("ef-job-20");
    expect(listing?.contract).toBe("AGGREGATED");
    expect(listing?.claimState).toBe("unclaimed");
    expect(listing?.lastPushedAt?.toISOString()).toBe(pushedAt.toISOString());
  });

  it("a later push succeeds and clears the recorded reason", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", {
      listing: {
        jobId: "ef-job-21",
        contract: "AGGREGATED",
        lastPushedAt: new Date("2026-08-01T00:00:00.000Z"),
        claimState: "unclaimed",
        blockedReason: "eduFleet Exchange would not accept edits to this listing.",
      },
    });
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "ef-job-21", status: "active" }));

    const outcome = await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("PUSHED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await storedListing(String(vacancy._id)))?.blockedReason).toBeUndefined();
  });

  it("passes through a 403 reason it has no wording for, clipped, rather than losing it", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", {
      listing: { jobId: "ef-job-22", contract: "AGGREGATED", lastPushedAt: new Date() },
    });
    stubFetch(jsonResponse(403, { error: "nope", reason: "some_future_reason" }));

    const outcome = expectOutcome(
      await VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
      "BLOCKED",
    );

    expect(outcome.message).toContain("some_future_reason");
    expect((await storedListing(String(vacancy._id)))?.jobId).toBe("ef-job-22");
  });

  it("names the school's plan when Contract Two answers upgrade_required", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    await makeConnectedGrant("INS0001");
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(403, { error: "Free plan job limit reached", reason: "upgrade_required" }),
    );

    const outcome = expectOutcome(
      await VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
      "BLOCKED",
    );

    expect(outcome.message).toContain("plan");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Nothing was created, so there is no listing to hang a reason on — and
    // inventing one would mean inventing a jobId eduFleet never issued.
    expect(await storedListing(String(vacancy._id))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — CONFLICT trusts the response's contract
// ---------------------------------------------------------------------------

describe("rule 6: CONFLICT trusts the response's contract", () => {
  it("records and surfaces the OTHER contract's ownership without retrying", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    await makeConnectedGrant("INS0001");
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch(
      jsonResponse(409, {
        error: 'A job with externalJobId "x" already exists — PATCH it instead',
        reason: "duplicate_external_job",
        jobId: "ef-job-30",
        // IDAP pushed under Contract Two; eduFleet says Contract One owns the
        // row. Retrying against the school PATCH endpoint would 404.
        contract: "platform",
      }),
    );

    const outcome = expectOutcome(
      await VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
      "CONFLICT",
    );

    expect(outcome.ownedByContract).toBe("AGGREGATED");
    expect(outcome.message).toMatch(/platform key/i);
    // Exactly one call: a 409 has already burned a write unit, and the
    // endpoint that would "obviously" own it is the one that just refused.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No listing is fabricated. eduFleet named a contract, not a jobId IDAP
    // could address, and a made-up one would show the school a "published"
    // vacancy pointing at nothing.
    expect(await storedListing(String(vacancy._id))).toBeUndefined();
  });

  it("still names the collision when eduFleet reports a contract IDAP does not know", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001");
    stubFetch(
      jsonResponse(409, {
        error: "already exists",
        reason: "duplicate_external_job",
        contract: "some-future-contract",
      }),
    );

    const outcome = expectOutcome(
      await VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
      "CONFLICT",
    );

    expect(outcome.ownedByContract).toBeUndefined();
    expect(outcome.message).toContain("some-future-contract");
  });
});

// ---------------------------------------------------------------------------
// Rule 7 — ConnectorAuthError propagates
// ---------------------------------------------------------------------------

describe("rule 7: ConnectorAuthError propagates", () => {
  it("lets a revoked grant surface as ConnectorAuthError instead of a generic failure", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    await makeConnectedGrant("INS0001");
    const vacancy = await makeVacancy("INS0001");
    stubFetch(jsonResponse(401, { error: "Grant revoked", reason: "revoked" }));

    await expect(
      VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
    ).rejects.toBeInstanceOf(ConnectorAuthError);

    // Nothing was recorded: the credential is dead, not the vacancy.
    expect(await storedListing(String(vacancy._id))).toBeUndefined();
  });

  it("maps every other transport failure to an actionable upstream error, not a scrubbed 500", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001");
    stubFetch(jsonResponse(500, { error: "boom" }));

    await expect(
      VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 502 });
  });
});

// ---------------------------------------------------------------------------
// Tenant scoping
// ---------------------------------------------------------------------------

describe("tenant scoping", () => {
  it("MUTATION-DISTINGUISHING: another institution's vacancy is not found, is left untouched, and is never pushed", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await makeCredential();
    const foreign = await makeVacancy("INS0002");
    const before = await Vacancy.findById(foreign._id).lean<VacancyDoc>();
    // A response a cross-tenant push would have succeeded with, queued so it
    // stays unused.
    const fetchMock = stubFetch(jsonResponse(201, { jobId: "ef-job-leak", status: "active" }));

    // Caught rather than `rejects.toThrow`, so all three guarantees are
    // checked on every run: a wrong outcome must not stop the assertions that
    // prove the neighbour's row was neither pushed nor written.
    const outcome = await VacancyPublishService.publish("INS0001", String(foreign._id), actor).catch(
      (error: unknown) => error,
    );

    expect(outcome).toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await Vacancy.findById(foreign._id).lean<VacancyDoc>();
    expect(after).toEqual(before);
  });

  it("scopes the close push too", async () => {
    await makeInstitution("INS0001");
    await makeInstitution("INS0002");
    await makeCredential();
    const foreign = await makeVacancy("INS0002", {
      status: "CLOSED",
      listing: { jobId: "ef-job-40", contract: "AGGREGATED", lastPushedAt: new Date() },
    });
    const fetchMock = stubFetch();

    await expect(
      VacancyPublishService.pushClose("INS0001", String(foreign._id), actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a malformed id as no such vacancy rather than a cast error", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const fetchMock = stubFetch();

    await expect(
      VacancyPublishService.publish("INS0001", "not-an-object-id", actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// repush / pushClose
// ---------------------------------------------------------------------------

describe("repush", () => {
  it("refuses to create a listing for a vacancy the school never published", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch();

    await expect(
      VacancyPublishService.repush("INS0001", String(vacancy._id), actor),
    ).rejects.toThrow("Publish this vacancy to eduFleet Exchange before updating its listing");

    // Consent: a vacancy reaches a public jobs board only by an explicit
    // publish, never as a side effect of an edit.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pushClose", () => {
  it("does nothing at all for a vacancy that was never published", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch();

    const outcome = await VacancyPublishService.pushClose("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("NOT_LISTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still closes a listing when the institution's city has since been cleared", async () => {
    // A close body is `{status:"closed"}` — it carries none of the fields the
    // city gate or `preflight` describe, and cannot 400 on their account.
    // Gating it on them would strand a live public advert IDAP can no longer
    // retract, which is the exact harm Task 5's delete-closes-first exists to
    // prevent.
    await makeInstitution("INS0001", { city: undefined });
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", {
      status: "CLOSED",
      listing: { jobId: "ef-job-50", contract: "AGGREGATED", lastPushedAt: new Date() },
    });
    const fetchMock = stubFetch(jsonResponse(200, { jobId: "ef-job-50", status: "closed" }));

    const outcome = await VacancyPublishService.pushClose("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("CLOSED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records a 403 on close without latching the listing", async () => {
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001", {
      status: "FILLED",
      listing: { jobId: "ef-job-51", contract: "AGGREGATED", lastPushedAt: new Date(), claimState: "unclaimed" },
    });
    stubFetch(jsonResponse(403, { error: "claimed", reason: "claimed" }));

    const outcome = await VacancyPublishService.pushClose("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("BLOCKED");
    const listing = await storedListing(String(vacancy._id));
    expect(listing?.jobId).toBe("ef-job-51");
    expect(listing?.blockedReason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Guards that keep a successful push from being lost
// ---------------------------------------------------------------------------

describe("recording a successful push", () => {
  it("does not store a claim state IDAP's own enum has never heard of", async () => {
    // eduFleet's CLAIM_STATUSES has four values (`Job.ts:13`) and IDAP's
    // VACANCY_CLAIM_STATES has three — `withdrawn` is eduFleet-only. Storing
    // it verbatim would throw on save AFTER the job went live, orphaning a
    // public advert IDAP has no id for.
    await makeInstitution("INS0001");
    await makeCredential();
    const vacancy = await makeVacancy("INS0001");
    stubFetch(jsonResponse(201, { jobId: "ef-job-60", status: "active", claimStatus: "withdrawn" }));

    const outcome = await VacancyPublishService.publish("INS0001", String(vacancy._id), actor);

    expect(outcome.status).toBe("PUSHED");
    const listing = await storedListing(String(vacancy._id));
    expect(listing?.jobId).toBe("ef-job-60");
    expect(listing?.claimState).toBe("unclaimed");
  });

  it("refuses when eduFleet has no active credential, before touching the network", async () => {
    await makeInstitution("INS0001");
    const vacancy = await makeVacancy("INS0001");
    const fetchMock = stubFetch();

    await expect(
      VacancyPublishService.publish("INS0001", String(vacancy._id), actor),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
