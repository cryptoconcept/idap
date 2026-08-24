/**
 * True only when `url` names a public media object this service minted for this
 * institution. Every upload is stored under the key `media/<institutionId>/…`,
 * and both adapters keep that path in the handle they hand back: the local
 * adapter returns `/api/media/media/<institutionId>/…`, and Vercel Blob returns
 * a blob URL whose pathname is `/media/<institutionId>/<id>-<random><ext>`.
 *
 * This is a provenance check, not a cosmetic one. `logoUrl` is free text on the
 * profile PATCH, so an institution can point its own field at another
 * institution's public media URL — which is observable on any published
 * profile. A cleanup delete that trusted the stored URL would then delete a
 * different tenant's object out of the shared store, because neither adapter's
 * `deletePublic` is tenant-scoped.
 *
 * Only the path is matched: a query string or fragment can carry any substring.
 * A percent-encoded or traversing path is refused outright — a key this service
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
