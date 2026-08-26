import { afterEach, describe, expect, it, vi } from "vitest";
import { localStorageAdapter } from "@/lib/storage/local";
import { blobStorageAdapter } from "@/lib/storage/blob";

describe("storage.getPublic — local adapter", () => {
  it("round-trips bytes and content type written by putPublic", async () => {
    const key = "media/INS0001/getpublic-test.png";
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);

    await localStorageAdapter.putPublic({ key, body, contentType: "image/png" });
    try {
      const result = await localStorageAdapter.getPublic(key);
      expect(result).not.toBeNull();
      expect(result?.body).toEqual(body);
      expect(result?.contentType).toBe("image/png");
    } finally {
      await localStorageAdapter.deletePublic(key);
    }
  });

  it("returns null for a missing key rather than throwing", async () => {
    const result = await localStorageAdapter.getPublic("media/INS0001/does-not-exist.png");
    expect(result).toBeNull();
  });

  it("returns null rather than throwing for a key that tries to escape the media root", async () => {
    // Enough `../` segments to actually reach filesystem root and a file that
    // exists there (`/etc/hosts`) — a shallower escape resolves to a path that
    // simply doesn't exist, which would return null via ENOENT regardless of
    // whether the escape guard runs at all, masking a guard regression.
    const result = await localStorageAdapter.getPublic("../../../../etc/hosts");
    expect(result).toBeNull();
  });
});

describe("storage.getPublic — blob adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the key as an absolute URL and returns bytes/content-type", async () => {
    const body = Buffer.from("fake-image-bytes");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await blobStorageAdapter.getPublic("https://blob.example/x.jpg");

    expect(fetchMock).toHaveBeenCalledWith("https://blob.example/x.jpg");
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("image/jpeg");
    expect(Buffer.from(result?.body ?? new Uint8Array()).equals(body)).toBe(true);
  });

  it("returns null when the response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await blobStorageAdapter.getPublic("https://blob.example/missing.jpg");

    expect(result).toBeNull();
  });
});
