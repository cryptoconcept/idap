import { describe, expect, it } from "vitest";
import {
  signAccessToken,
  signSession,
  verifyAccessToken,
  verifySessionToken,
} from "@/lib/auth/session";

const payload = {
  sub: "6a8880f3446c577c470cd06c",
  role: "INSTITUTION_ADMIN" as const,
  institutionId: "INS0001",
  name: "Institution Admin",
  email: "admin@example.test",
  v: 0,
};

describe("mobile access tokens", () => {
  it("round-trips a mobile token", async () => {
    const verified = await verifyAccessToken(await signAccessToken(payload));
    expect(verified).toMatchObject(payload);
  });

  it("does not accept a dashboard session as a mobile token", async () => {
    // The audience split is what stops a stolen cookie being replayed at the API.
    expect(await verifyAccessToken(await signSession(payload))).toBeNull();
  });

  it("does not accept a mobile token as a dashboard session", async () => {
    expect(await verifySessionToken(await signAccessToken(payload))).toBeNull();
  });

  it("rejects a tampered mobile token", async () => {
    const token = await signAccessToken(payload);
    const [header, body, signature] = token.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString());
    forged.institutionId = "INS9999";
    const tampered = [
      header,
      Buffer.from(JSON.stringify(forged)).toString("base64url"),
      signature,
    ].join(".");

    expect(await verifyAccessToken(tampered)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", "nope", "a.b.c"]) {
      expect(await verifyAccessToken(bad)).toBeNull();
    }
  });
});
