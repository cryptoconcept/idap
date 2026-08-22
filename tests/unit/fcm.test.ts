import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { sendPush } from "@/lib/push/fcm";

// A real key pair, so `importPKCS8` and the JWT assertion run for real rather
// than being stubbed out. Only `fetch` is faked.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const OAUTH_URL = "https://oauth2.googleapis.com/token";

type FcmReply = { status: number; body: unknown };

/** Reply per push token, so one send can mix outcomes across devices. */
let replies: Record<string, FcmReply> = {};

function jsonResponse({ status, body }: FcmReply): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const message = (pushToken: string) => ({
  pushToken,
  title: "New application",
  body: "Rahul Kumar — Grade 5",
  data: { type: "application", reference: "INS0001-APP-000001" },
});

/** The shape FCM v1 actually returns for a token it no longer recognises. */
const UNREGISTERED = {
  status: 404,
  body: {
    error: {
      code: 404,
      status: "NOT_FOUND",
      message: "Requested entity was not found.",
      details: [
        {
          "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
          errorCode: "UNREGISTERED",
        },
      ],
    },
  },
};

/**
 * What a *message* regression looks like: 400 INVALID_ARGUMENT, returned
 * identically for every device because the fault is in the payload, not in any
 * one registration.
 */
const BAD_MESSAGE = {
  status: 400,
  body: {
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "Invalid JSON payload received. Unknown name \"notifcation\".",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.BadRequest",
          fieldViolations: [{ field: "message", description: "Invalid JSON payload received." }],
        },
      ],
    },
  },
};

/** 400, but the violation names the token itself. */
const BAD_TOKEN = {
  status: 400,
  body: {
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: "The registration token is not a valid FCM registration token",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.BadRequest",
          fieldViolations: [
            { field: "message.token", description: "Invalid registration token" },
          ],
        },
      ],
    },
  },
};

/** An expired or revoked service account key: every message fails the same way. */
const AUTH_FAILED = {
  status: 401,
  body: {
    error: {
      code: 401,
      status: "UNAUTHENTICATED",
      message: "Request had invalid authentication credentials.",
    },
  },
};

describe("sendPush", () => {
  const originalFetch = globalThis.fetch;
  const originalAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

  beforeAll(() => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
      client_email: "push@aem-platform.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY_PEM,
      project_id: "aem-platform",
    });
  });

  afterAll(() => {
    if (originalAccount === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
    else process.env.FIREBASE_SERVICE_ACCOUNT = originalAccount;
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    replies = {};
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === OAUTH_URL) {
        return jsonResponse({ status: 200, body: { access_token: "fcm-access-token" } });
      }
      const sent = JSON.parse(String(init?.body)) as { message: { token: string } };
      const reply = replies[sent.message.token] ?? { status: 200, body: { name: "sent" } };
      return jsonResponse(reply);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prunes a token FCM reports as UNREGISTERED", async () => {
    replies = { "token-gone": UNREGISTERED };

    const { deadTokens } = await sendPush([message("token-gone"), message("token-live")]);
    expect(deadTokens).toEqual(["token-gone"]);
  });

  it("reads UNREGISTERED from the body, not from the 404", async () => {
    // Otherwise this test and the one above are the same test: a bare
    // `status === 404` rule satisfies both, and any 404 that is not FCM
    // reporting a dead registration — a mistyped project path, a proxy — would
    // delete every device the institution has.
    replies = {
      "token-a": {
        status: 404,
        body: { error: { code: 404, status: "NOT_FOUND", message: "Not Found" } },
      },
    };

    const { deadTokens } = await sendPush([message("token-a")]);
    expect(deadTokens).toEqual([]);
  });

  it("keeps every registration when the message itself is rejected", async () => {
    // The regression this exists for. A payload mistake returns 400 for every
    // device at once, so deleting on the status alone wipes an entire
    // institution's registrations in a single submission — and devices only
    // re-register at app start, so push stays dark until everyone relaunches.
    replies = {
      "token-a": BAD_MESSAGE,
      "token-b": BAD_MESSAGE,
      "token-c": BAD_MESSAGE,
    };

    const { deadTokens } = await sendPush([
      message("token-a"),
      message("token-b"),
      message("token-c"),
    ]);
    expect(deadTokens).toEqual([]);
  });

  it("still prunes a 400 whose field violation names the token", async () => {
    replies = { "token-malformed": BAD_TOKEN, "token-a": BAD_MESSAGE };

    const { deadTokens } = await sendPush([message("token-malformed"), message("token-a")]);
    expect(deadTokens).toEqual(["token-malformed"]);
  });

  it("logs an authentication failure instead of swallowing it", async () => {
    // 401/403 means the service account key is expired or revoked. Without a
    // log this failure mode is invisible: push simply stops.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    replies = { "token-a": AUTH_FAILED };

    const { deadTokens } = await sendPush([message("token-a")]);

    expect(deadTokens).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      "[push] FCM rejected a message",
      expect.objectContaining({ httpStatus: 401, status: "UNAUTHENTICATED" }),
    );
    // The registration token must not reach a shared log.
    expect(JSON.stringify(logged.mock.calls)).not.toContain("token-a");
  });

  it("says nothing when every message is accepted", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { deadTokens } = await sendPush([message("token-a"), message("token-b")]);

    expect(deadTokens).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("does nothing at all without a service account", async () => {
    const saved = process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    try {
      expect(await sendPush([message("token-a")])).toEqual({ deadTokens: [] });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      process.env.FIREBASE_SERVICE_ACCOUNT = saved;
    }
  });
});
