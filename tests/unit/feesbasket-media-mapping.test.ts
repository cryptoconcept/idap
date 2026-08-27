import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { buildMediaPayload } from "@/lib/media/feesbasket-mapping";
import type { MediaItem } from "@/lib/media/feesbasket-mapping";

/**
 * The real field-level shape IDAP's Mongoose layer actually produces for one
 * media item — confirmed against this repo's own `tsc`, the same way I3's
 * finding was: reading `(await Institution.findOne({}).lean())!.media![0]`
 * and forcing each field's inferred type into a compile error shows
 * `title`/`caption`/`videoId` as `string | null | undefined` (not
 * `string | undefined`) and `provider` as `"YOUTUBE" | "VIMEO" | null |
 * undefined` — Mongoose types every optional string path as nullable, which
 * is exactly the mismatch I3 reported against the OLD `MediaItem`
 * (`title?: string`, etc.). `_id` is a real `Types.ObjectId`, not `unknown`.
 * A hand-rolled interface, not `InstitutionDoc["media"][number]` itself,
 * because that type is a Mongoose `Subdocument` class (54+ instance members
 * like `$isSingleNested`) that no plain object — real `.lean()` data
 * included — can be structurally checked against; the class-shaped TS type
 * doesn't reflect the plain-object runtime value.
 */
interface RealMediaItem {
  _id: Types.ObjectId;
  kind: "IMAGE" | "VIDEO" | "BROCHURE" | "PROSPECTUS";
  url: string;
  title?: string | null;
  caption?: string | null;
  sortOrder: number;
  status: "ACTIVE" | "HIDDEN";
  provider?: "YOUTUBE" | "VIMEO" | null;
  videoId?: string | null;
  uploadedAt: Date;
}

// `tests/helpers/setup.ts` fixes NEXT_PUBLIC_APP_URL to "https://admissions.test"
// for every test file, so a relative `url` always resolves to a real,
// externally-reachable host unless a test deliberately overrides it.

const ALL_KINDS = ["image", "video", "brochure", "prospectus"];

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    _id: "665f1a2b3c4d5e6f7a8b9c0d",
    kind: "IMAGE",
    url: "https://cdn.example.com/campus.jpg",
    sortOrder: 0,
    status: "ACTIVE",
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function ctx(mediaKinds: string[] = ALL_KINDS): { mediaKinds: string[]; warnings: string[] } {
  return { mediaKinds, warnings: [] };
}

describe("buildMediaPayload", () => {
  it("maps each of the four kinds to its lowercase FeesBasket name", () => {
    const c = ctx();
    const result = buildMediaPayload(
      [
        makeItem({ _id: "1", kind: "IMAGE" }),
        makeItem({ _id: "2", kind: "VIDEO", url: "https://www.youtube.com/watch?v=abcdefghijk" }),
        makeItem({ _id: "3", kind: "BROCHURE" }),
        makeItem({ _id: "4", kind: "PROSPECTUS" }),
      ],
      c,
    );

    expect(result.map((m) => m.kind)).toEqual(["image", "video", "brochure", "prospectus"]);
    expect(c.warnings).toEqual([]);
  });

  it("carries the item's real _id through as externalId, exactly, as a string", () => {
    const item = makeItem({ _id: "665f1a2b3c4d5e6f7a8b9c0d" });
    const result = buildMediaPayload([item], ctx());
    expect(result).toHaveLength(1);
    expect(result[0].externalId).toBe("665f1a2b3c4d5e6f7a8b9c0d");
  });

  it("stringifies a non-string _id (e.g. a Mongoose ObjectId) rather than inventing a value", () => {
    const fakeObjectId = { toString: () => "aaaabbbbccccddddeeeeffff" };
    const item = makeItem({ _id: fakeObjectId as unknown as string });
    const result = buildMediaPayload([item], ctx());
    expect(result[0].externalId).toBe("aaaabbbbccccddddeeeeffff");
  });

  it("excludes HIDDEN items", () => {
    const visible = makeItem({ _id: "visible", status: "ACTIVE" });
    const hidden = makeItem({ _id: "hidden", status: "HIDDEN" });
    const result = buildMediaPayload([visible, hidden], ctx());

    expect(result).toHaveLength(1);
    expect(result[0].externalId).toBe("visible");
  });

  it("skips a kind absent from ctx.mediaKinds, with a warning naming that item, and never sends it", () => {
    const c = ctx(["image", "video", "brochure"]); // "prospectus" deliberately missing
    const unmapped = makeItem({ _id: "p1", kind: "PROSPECTUS", title: "2026 Prospectus" });
    const mapped = makeItem({ _id: "i1", kind: "IMAGE" });

    const result = buildMediaPayload([unmapped, mapped], c);

    expect(result).toHaveLength(1);
    expect(result[0].externalId).toBe("i1");
    expect(result.some((m) => m.externalId === "p1")).toBe(false);

    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toContain("p1");
    expect(c.warnings[0]).toContain("2026 Prospectus");
  });

  it("resolves a relative url to an absolute one", () => {
    const item = makeItem({ url: "/api/media/media/INS0001/campus.jpg" });
    const result = buildMediaPayload([item], ctx());
    expect(result[0].url).toBe("https://admissions.test/api/media/media/INS0001/campus.jpg");
  });

  it("throws for a localhost url rather than pushing it", () => {
    const item = makeItem({ url: "http://localhost:3000/api/media/media/INS0001/campus.jpg" });
    expect(() => buildMediaPayload([item], ctx())).toThrow(/not reachable/i);
  });

  it("throws when the default dev APP_URL (localhost) would make a relative url resolve to a dead link", () => {
    // Regression guard for the exact scenario called out in the task brief:
    // NEXT_PUBLIC_APP_URL unset defaults to http://localhost:3000
    // (`src/lib/env.ts`), so a stored relative key resolves to a localhost
    // URL unless a real public address has been configured.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    try {
      const item = makeItem({ url: "/api/media/media/INS0001/campus.jpg" });
      expect(() => buildMediaPayload([item], ctx())).toThrow(/not reachable/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes captions through unchanged", () => {
    const item = makeItem({ caption: "The main auditorium, seats 800" });
    const result = buildMediaPayload([item], ctx());
    expect(result[0].caption).toBe("The main auditorium, seats 800");
  });

  it("emits caption: null (explicitly present, not an omitted key) when the item has none", () => {
    // MUTATION-DISTINGUISHING: this is the only thing standing between an
    // admin clearing a caption and that caption staying stuck on a public
    // FeesBasket listing forever. The map's merge rule treats an absent key
    // as "leave it alone" and only an explicit `null` as "clear it" — so
    // `toEqual`, which treats `{caption: undefined}` and `{}` as equivalent,
    // would let a regression back to "omit when absent" pass silently. The
    // `in` check is what actually distinguishes "key present with value
    // null" from "key missing".
    const item = makeItem({ caption: undefined });
    const result = buildMediaPayload([item], ctx());
    expect("caption" in result[0]).toBe(true);
    expect(result[0].caption).toBeNull();
  });

  // Proves the I3 fix, not just documents it: `RealMediaItem` above is IDAP's
  // real, tsc-confirmed field typing (`string | null | undefined` throughout,
  // `_id: Types.ObjectId`). `satisfies` checks this literal against that real
  // shape without widening the literal's own type, so it stays a fresh
  // object literal — which is what makes the next line meaningful: it is
  // passed straight into `buildMediaPayload`'s parameter with NO `as` and NO
  // `as unknown as MediaItem`. The OLD `MediaItem` (`title?: string`, etc.)
  // rejected exactly this literal; if `MediaItem` ever regresses to a strict
  // shape again, this is the line that stops compiling.
  it("accepts IDAP's real field typing — string|null|undefined throughout, no cast", () => {
    const realItem = {
      _id: new Types.ObjectId("665f1a2b3c4d5e6f7a8b9c0d"),
      kind: "IMAGE",
      url: "https://cdn.example.com/campus.jpg",
      title: null,
      caption: null,
      sortOrder: 0,
      status: "ACTIVE",
      provider: null,
      videoId: null,
      uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    } satisfies RealMediaItem;

    const result = buildMediaPayload([realItem], ctx());

    expect(result).toHaveLength(1);
    expect(result[0].externalId).toBe("665f1a2b3c4d5e6f7a8b9c0d");
    expect(result[0].kind).toBe("image");
    expect(result[0].caption).toBeNull();
  });
});
