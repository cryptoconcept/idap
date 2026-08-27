import { afterEach, describe, expect, it, vi } from "vitest";
import { localStorageAdapter } from "@/lib/storage/local";
import { blobStorageAdapter } from "@/lib/storage/blob";

describe("storage.getPublic — local adapter", () => {
  // F2 (fix round 2): the original version of this test called `getPublic`
  // with the RAW key it made up, not the value `putPublic` actually
  // returned. Production never produces that raw-key shape —
  // `ResultService.setTopperPhoto` persists exactly what `putPublic` returns
  // (`src/services/result.service.ts`) — so the test passed while every
  // topper photo on this backend silently failed to resolve. Fixed to feed
  // `getPublic` the real returned shape, and to pin BOTH forms so neither
  // can silently regress again.
  it("round-trips using the exact (prefixed) key putPublic returned — the shape production actually stores", async () => {
    const key = "media/INS0001/getpublic-test.png";
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);

    const stored = await localStorageAdapter.putPublic({ key, body, contentType: "image/png" });
    // Pin the prefixed shape itself — if `putPublic` ever stopped returning
    // this, the rest of the test would silently stop exercising it.
    expect(stored.key).toBe(`/api/media/${key}`);

    try {
      const result = await localStorageAdapter.getPublic(stored.key);
      expect(result).not.toBeNull();
      expect(result?.body).toEqual(body);
      expect(result?.contentType).toBe("image/png");
    } finally {
      await localStorageAdapter.deletePublic(stored.key);
    }
  });

  it("also resolves the raw, unprefixed key — both forms must keep working", async () => {
    const key = "media/INS0001/getpublic-test-raw.png";
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]);

    await localStorageAdapter.putPublic({ key, body, contentType: "image/png" });
    try {
      const result = await localStorageAdapter.getPublic(key); // raw — no /api/media/ prefix
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
