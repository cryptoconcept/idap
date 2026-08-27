import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDatabase, startTestDatabase, stopTestDatabase } from "../helpers/db";
import { makeInstitution } from "../helpers/factories";
import { Institution } from "@/models";
import { InstitutionService } from "@/services/institution.service";
import { MEDIA_MAX_ITEMS, MEDIA_MAX_PDF_BYTES } from "@/lib/constants";
import { storage } from "@/lib/storage";

const ACTOR = { id: "6a8880f3446c577c470cd06c", name: "Test Admin" };

/** A minimal but real PDF header — passes the `%PDF-` magic-byte sniff. */
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< >>\nendobj\n%%EOF", "binary");

/** A YouTube URL `normalizeVideoUrl` (Task 1) recognizes. */
const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
/** Same video, different URL shape — normalizes to the same (provider, videoId). */
const YOUTUBE_SHORT_URL = "https://youtu.be/dQw4w9WgXcQ";

describe("institution media service — documents and video links", () => {
  beforeAll(async () => {
    await startTestDatabase("institutionmedia");
    await Institution.syncIndexes();
  });
  afterAll(stopTestDatabase);
  beforeEach(clearDatabase);

  describe("addMediaDocument", () => {
    it("stores a valid PDF and appends it as a BROCHURE item with the storage key as its url", async () => {
      await makeInstitution("INS0001");

      const after = await InstitutionService.addMediaDocument(
        "INS0001",
        {
          kind: "BROCHURE",
          fileName: "brochure.pdf",
          contentType: "application/pdf",
          bytes: PDF,
          title: "2026 Brochure",
        },
        ACTOR,
      );

      expect(after.media).toHaveLength(1);
      const item = after.media![0]!;
      expect(item.kind).toBe("BROCHURE");
      expect(item.title).toBe("2026 Brochure");
      expect(item.url).toContain("media/INS0001/documents/");
      expect(item.url.endsWith(".pdf")).toBe(true);
    });

    it("MUTATION-DISTINGUISHING: magic bytes, not the declared content type", async () => {
      await makeInstitution("INS0001");

      // A client controls both the filename and the declared content type —
      // an attacker (or a mislabeled file) can claim to be a PDF without
      // being one. Only the bytes prove anything.
      await expect(
        InstitutionService.addMediaDocument(
          "INS0001",
          {
            kind: "BROCHURE",
            fileName: "evil.pdf",
            contentType: "application/pdf",
            bytes: Buffer.from("#!/bin/sh\nrm -rf /\n"),
          },
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
      expect(row!.media ?? []).toHaveLength(0);
    });

    // Task 5's review flagged that this method's own runtime check —
    // `mediaUploadSchema.parse({ kind: input.kind, ... })` — validated
    // against a `kind` enum that also allows `IMAGE`, wider than this
    // method's declared `"BROCHURE" | "PROSPECTUS"` type. Nothing called it
    // at the time, so TypeScript alone kept bad values out; Task 6 wires an
    // HTTP route in front of it, where form data arrives as untyped strings
    // and a route-level guard is the only thing standing between an
    // out-of-contract `kind` and the `kind === "BROCHURE" ? "brochures" :
    // "prospectuses"` ternary silently mislabeling the storage key and
    // activity log. The route now narrows `kind` before ever calling this
    // method — but this test proves the fix is in the method's own contract
    // check (`mediaDocumentKindSchema`, narrower than `mediaUploadSchema`),
    // not merely in that one call site, so any future caller is held to it
    // too. `as never` simulates a caller that bypasses TypeScript's own
    // narrowing, exactly as untyped form data would.
    it("refuses an out-of-contract kind rather than misfiling it, and stores nothing", async () => {
      await makeInstitution("INS0001");

      await expect(
        InstitutionService.addMediaDocument(
          "INS0001",
          {
            kind: "IMAGE" as never,
            fileName: "brochure.pdf",
            contentType: "application/pdf",
            bytes: PDF,
          },
          ACTOR,
        ),
      ).rejects.toThrow();

      const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
      expect(row!.media ?? []).toHaveLength(0);
    });

    it("refuses a PDF over MEDIA_MAX_PDF_BYTES and stores nothing", async () => {
      await makeInstitution("INS0001");

      const oversized = Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.alloc(MEDIA_MAX_PDF_BYTES),
      ]);

      const putPublic = vi.spyOn(storage, "putPublic");
      try {
        await expect(
          InstitutionService.addMediaDocument(
            "INS0001",
            {
              kind: "BROCHURE",
              fileName: "huge.pdf",
              contentType: "application/pdf",
              bytes: oversized,
            },
            ACTOR,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        // The oversize check must happen before storage is ever touched — a
        // check placed after the upload would pass a throws-only assertion
        // while still burning storage on every rejected file.
        expect(putPublic).not.toHaveBeenCalled();
      } finally {
        putPublic.mockRestore();
      }

      const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
      expect(row!.media ?? []).toHaveLength(0);
    });

    // This is the deliberately corrected version of the brief's literal
    // "fill BROCHURE to its cap, then an image still succeeds" — see the
    // task report for why that pairing (10 brochures vs. a 60-image cap)
    // cannot actually distinguish a per-kind cap from a shared one. BROCHURE
    // and PROSPECTUS share the SAME limit (10), so filling one to the brim
    // and then succeeding on the other is the pairing where a broken
    // (unfiltered, or wrongly-shared) cap check would visibly reject the
    // prospectus instead of allowing it.
    it("enforces the per-kind cap for BROCHURE without it bleeding into PROSPECTUS", async () => {
      await makeInstitution("INS0001", {
        media: Array.from({ length: MEDIA_MAX_ITEMS.BROCHURE }, (_, i) => ({
          kind: "BROCHURE",
          url: `https://cdn.test/brochure-${i}.pdf`,
          status: "ACTIVE",
        })),
      });

      await expect(
        InstitutionService.addMediaDocument(
          "INS0001",
          { kind: "BROCHURE", fileName: "one-too-many.pdf", contentType: "application/pdf", bytes: PDF },
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const after = await InstitutionService.addMediaDocument(
        "INS0001",
        { kind: "PROSPECTUS", fileName: "prospectus.pdf", contentType: "application/pdf", bytes: PDF },
        ACTOR,
      );

      expect(after.media).toHaveLength(MEDIA_MAX_ITEMS.BROCHURE + 1);
      expect(after.media!.filter((m) => m.kind === "PROSPECTUS")).toHaveLength(1);
    });

    it("MUTATION-DISTINGUISHING: never lets an addMediaDocument call for one institution reach another's media", async () => {
      // INS0001 is already at its BROCHURE cap, so a correctly-scoped call
      // must be refused for INS0001 specifically...
      await makeInstitution("INS0001", {
        media: Array.from({ length: MEDIA_MAX_ITEMS.BROCHURE }, (_, i) => ({
          kind: "BROCHURE",
          url: `https://cdn.test/brochure-${i}.pdf`,
          status: "ACTIVE",
        })),
      });
      // ...while INS0002 has room. A filter missing `institutionId` would
      // still satisfy the `$expr` cap check against INS0002 and silently
      // push the document there instead of failing the call.
      await makeInstitution("INS0002");

      await expect(
        InstitutionService.addMediaDocument(
          "INS0001",
          { kind: "BROCHURE", fileName: "one-too-many.pdf", contentType: "application/pdf", bytes: PDF },
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const victim = await Institution.findOne({ institutionId: "INS0002" }).lean();
      expect(victim!.media ?? []).toHaveLength(0);
    });
  });

  describe("addMediaVideo", () => {
    it("creates a VIDEO item from a valid YouTube URL with provider, videoId, and the canonical url", async () => {
      await makeInstitution("INS0001");

      const after = await InstitutionService.addMediaVideo(
        "INS0001",
        { url: "https://m.youtube.com/watch?v=dQw4w9WgXcQ", title: "Campus Tour" },
        ACTOR,
      );

      expect(after.media).toHaveLength(1);
      const item = after.media![0]!;
      expect(item.kind).toBe("VIDEO");
      expect(item.provider).toBe("YOUTUBE");
      expect(item.videoId).toBe("dQw4w9WgXcQ");
      expect(item.url).toBe(YOUTUBE_URL);
    });

    it("refuses a URL off the allowlist, naming what is supported", async () => {
      await makeInstitution("INS0001");

      let error: unknown;
      try {
        await InstitutionService.addMediaVideo(
          "INS0001",
          { url: "https://dailymotion.com/video/x123abc" },
          ACTOR,
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
      expect((error as Error).message).toMatch(/YouTube/i);
      expect((error as Error).message).toMatch(/Vimeo/i);

      const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
      expect(row!.media ?? []).toHaveLength(0);
    });

    it("refuses a duplicate (provider, videoId) and leaves the item count unchanged", async () => {
      await makeInstitution("INS0001");
      await InstitutionService.addMediaVideo("INS0001", { url: YOUTUBE_URL }, ACTOR);

      await expect(
        // A different URL shape normalising to the same video.
        InstitutionService.addMediaVideo("INS0001", { url: YOUTUBE_SHORT_URL }, ACTOR),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const row = await Institution.findOne({ institutionId: "INS0001" }).lean();
      expect(row!.media ?? []).toHaveLength(1);
    });

    it("MUTATION-DISTINGUISHING: never lets an addMediaVideo call for one institution reach another's media", async () => {
      // INS0001 is already at its VIDEO cap, so a correctly-scoped call must
      // be refused for INS0001 specifically...
      await makeInstitution("INS0001", {
        media: Array.from({ length: MEDIA_MAX_ITEMS.VIDEO }, (_, i) => ({
          kind: "VIDEO",
          url: `https://vimeo.com/${1000 + i}`,
          provider: "VIMEO",
          videoId: String(1000 + i),
          status: "ACTIVE",
        })),
      });
      // ...while INS0002 has room and no conflicting video. A filter missing
      // `institutionId` would still satisfy both the duplicate check and the
      // `$expr` cap check against INS0002 and silently push the video there.
      await makeInstitution("INS0002");

      await expect(
        InstitutionService.addMediaVideo("INS0001", { url: YOUTUBE_URL }, ACTOR),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const victim = await Institution.findOne({ institutionId: "INS0002" }).lean();
      expect(victim!.media ?? []).toHaveLength(0);
    });
  });
});
