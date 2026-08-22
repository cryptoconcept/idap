import "server-only";
import type { StorageAdapter } from "./types";
import { localStorageAdapter } from "./local";
import { blobStorageAdapter } from "./blob";

export type { StorageAdapter, StoredObject } from "./types";

/**
 * Vercel Blob when the deployment provides a token, local disk otherwise.
 * Selecting on the token rather than NODE_ENV means `vercel dev` and preview
 * deployments use the same storage as production, and a plain `next dev` still
 * works with nothing configured.
 */
export const storage: StorageAdapter = process.env.BLOB_READ_WRITE_TOKEN
  ? blobStorageAdapter
  : localStorageAdapter;

export const storageBackend = process.env.BLOB_READ_WRITE_TOKEN ? "vercel-blob" : "local-disk";
