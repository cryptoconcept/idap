import { describe, expect, it } from "vitest";
import { localStorageAdapter } from "@/lib/storage/local";

describe("public storage path", () => {
  it("returns a URL-shaped handle that needs no authentication to load", async () => {
    const stored = await localStorageAdapter.putPublic({
      key: "media/INS0001/logo-test.png",
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      contentType: "image/png",
    });

    // The handle is what a third-party website will put in an <img src>.
    expect(stored.key).toBe("/api/media/media/INS0001/logo-test.png");
    await localStorageAdapter.deletePublic("media/INS0001/logo-test.png");
  });

  it("rejects a key that tries to escape the media root", async () => {
    await expect(
      localStorageAdapter.putPublic({
        key: "../../etc/passwd",
        body: Buffer.from("x"),
        contentType: "image/png",
      }),
    ).rejects.toThrow();
  });
});
