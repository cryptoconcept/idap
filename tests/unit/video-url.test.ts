import { describe, it, expect } from "vitest";
import { normalizeVideoUrl } from "@/lib/media/video-url";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("normalizeVideoUrl — YouTube shapes", () => {
  const shapes = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "  https://youtu.be/dQw4w9WgXcQ  ",
  ];

  for (const shape of shapes) {
    it(`normalises ${shape.trim()}`, () => {
      expect(normalizeVideoUrl(shape)).toEqual({
        provider: "YOUTUBE",
        videoId: "dQw4w9WgXcQ",
        url: YT,
      });
    });
  }
});

describe("normalizeVideoUrl — Vimeo shapes", () => {
  it("normalises vimeo.com/ID", () => {
    expect(normalizeVideoUrl("https://vimeo.com/123456789")).toEqual({
      provider: "VIMEO",
      videoId: "123456789",
      url: "https://vimeo.com/123456789",
    });
  });

  it("normalises player.vimeo.com/video/ID to the canonical form", () => {
    expect(normalizeVideoUrl("https://player.vimeo.com/video/123456789")).toEqual({
      provider: "VIMEO",
      videoId: "123456789",
      url: "https://vimeo.com/123456789",
    });
  });
});

describe("normalizeVideoUrl — rejections", () => {
  // MUTATION-DISTINGUISHING: an allowlist that accepted any host, or a regex
  // that matched loosely, would pass every test above and fail these.
  const rejected = [
    "https://evil.example.com/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)",
    "https://www.youtube.com/watch?v=short",
    "https://vimeo.com/notanumber",
    "https://www.youtube.com/",
    "not a url at all",
    "",
  ];

  for (const input of rejected) {
    it(`rejects ${input || "(empty string)"}`, () => {
      expect(normalizeVideoUrl(input)).toBeNull();
    });
  }
});
