/**
 * True only when `url` names a public media object this platform minted for this
 * institution. Every upload is stored under the key `media/<institutionId>/…`,
 * and both adapters keep that path in the handle they hand back: the local
 * adapter returns `/api/media/media/<institutionId>/…`, and Vercel Blob returns
 * a blob URL whose pathname is `/media/<institutionId>/<id>-<random><ext>`.
 *
 * This is a provenance check, not a cosmetic one. A stored media URL can be
 * attacker-influenced, so a cleanup delete that trusted it would delete a
 * different tenant's object out of the shared store — neither adapter's
 * `deletePublic` is tenant-scoped.
 *
 * Only the path is matched: a query string or fragment can carry any substring.
 * A percent-encoded or traversing path is refused outright — a key this platform
 * minted contains neither.
 */
export function isOwnedMediaUrl(url: string | null | undefined, institutionId: string): boolean {
  if (!url) return false;

  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      path = new URL(url).pathname;
    } catch {
      return false;
    }
  } else {
    path = url.split(/[?#]/, 1)[0] ?? "";
  }

  if (path.includes("%") || path.includes("..")) return false;
  return path.includes(`/media/${institutionId}/`);
}
