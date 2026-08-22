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
 * can be swapped for Blob / S3 / GCS without touching the services. Objects are
 * always private: they are served through an authenticated, tenant-checked
 * route rather than a public URL.
 */
export interface StorageAdapter {
  put(input: { key: string; body: Buffer; contentType: string }): Promise<StoredObject>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}
