export type StoredObject = {
  /**
   * The handle to read this object back with. Adapters may return something
   * other than the key that was passed in — Vercel Blob returns a blob URL —
   * so callers must persist this value rather than the key they supplied.
   */
  key: string;
  size: number;
  contentType: string;
};

/**
 * Storage is behind an interface so the local-disk adapter used in development
 * can be swapped for Blob / S3 / GCS without touching the services.
 *
 * Two paths, two contracts: `put`/`get`/`delete` are always private — they are
 * served through an authenticated, tenant-checked route rather than a public
 * URL, and that is the case for every caller except institution media.
 * `putPublic`/`deletePublic` are the sole exception: institution media (logo,
 * cover, gallery) that a third-party school website hot-links, so it must load
 * with no authentication. `DocumentService` must never call `putPublic`.
 */
export interface StorageAdapter {
  put(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;

  /**
   * Public path — institution media ONLY (logo, cover, gallery). The returned
   * key is a directly loadable URL: third-party websites hot-link it, so it
   * must never require authentication. Admission documents never go through
   * here; DocumentService is forbidden from calling it.
   */
  putPublic(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject>;
  deletePublic(key: string): Promise<void>;

  /**
   * Public path — institution media ONLY (logo, cover, gallery). Reads back
   * whatever `putPublic` returned as the stored key — a relative path on the
   * local adapter, an absolute blob URL on Vercel Blob. Returns `null` rather
   * than throwing when the media is unavailable; admission documents never go
   * through here.
   */
  getPublic(key: string): Promise<{ body: Buffer; contentType: string } | null>;
}
