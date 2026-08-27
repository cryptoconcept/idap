import { MEDIA_PROVIDERS } from "@/lib/constants";

export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

export type NormalizedVideo = {
  provider: MediaProvider;
  videoId: string;
  url: string;
};

/**
 * An explicit host allowlist, never a substring or regex match on the whole
 * URL. `youtube.com.evil.example` contains "youtube.com" and would satisfy a
 * loose match while being an entirely different origin, so hosts are compared
 * for exact equality after stripping a leading `www.`.
 */
const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "youtu.be"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "player.vimeo.com"]);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d+$/;

function host(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function youtubeId(url: URL, h: string): string | null {
  if (h === "youtu.be") return url.pathname.slice(1) || null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "embed" || segments[0] === "shorts") return segments[1] ?? null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  return null;
}

export function normalizeVideoUrl(input: string): NormalizedVideo | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // Anything other than http(s) — `javascript:`, `data:` — is refused before
  // the host is even considered.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const h = host(url);

  if (YOUTUBE_HOSTS.has(h)) {
    const videoId = youtubeId(url, h);
    if (!videoId || !YOUTUBE_ID.test(videoId)) return null;
    return {
      provider: "YOUTUBE",
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  if (VIMEO_HOSTS.has(h)) {
    const segments = url.pathname.split("/").filter(Boolean);
    const videoId = h === "player.vimeo.com" ? segments[1] : segments[0];
    if (!videoId || !VIMEO_ID.test(videoId)) return null;
    return { provider: "VIMEO", videoId, url: `https://vimeo.com/${videoId}` };
  }

  return null;
}
