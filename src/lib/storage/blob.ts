import "server-only";
import { del, get, put } from "@vercel/blob";
import type { StorageAdapter } from "./types";

/**
 * Vercel Blob adapter for production.
 *
 * Two separate stores, two separate tokens — never one store serving both
 * roles. Admission documents live in a private-access-only store
 * (`DOCUMENTS_BLOB_READ_WRITE_TOKEN`): a blob URL alone is not enough to read
 * one, the read goes through the app's authenticated, tenant-checked route.
 * Institution media lives in a public-access store (`BLOB_READ_WRITE_TOKEN`,
 * the SDK's default var), hot-linked directly by third-party websites. Kept
 * on separate tokens on purpose — a bug in the public path can only ever
 * reach the public store, never the store holding admission documents.
 *
 * `put` returns the blob's own URL, which becomes the stored handle — never
 * assume the key you passed in is the key you read back with.
 */
const DOCUMENTS_TOKEN = process.env.DOCUMENTS_BLOB_READ_WRITE_TOKEN;

export const blobStorageAdapter: StorageAdapter = {
  async put({ key, body, contentType }) {
    const blob = await put(key, body, {
      access: "private",
      contentType,
      token: DOCUMENTS_TOKEN,
      // The key is already unique (a generated ObjectId), and a stable handle
      // makes the stored reference predictable.
      addRandomSuffix: false,
    });

    return { key: blob.url, size: body.byteLength, contentType };
  },

  async get(key) {
    try {
      const result = await get(key, { access: "private", token: DOCUMENTS_TOKEN });
      // A 304 carries no stream; this read is unconditional, so treat it as a miss.
      if (!result || result.statusCode !== 200) return null;

      const body = Buffer.from(await new Response(result.stream).arrayBuffer());
      return {
        body,
        contentType: result.blob.contentType || "application/octet-stream",
      };
    } catch {
      return null;
    }
  },

  async delete(key) {
    await del(key, { token: DOCUMENTS_TOKEN }).catch(() => undefined);
  },

  async putPublic({ key, body, contentType }) {
    const blob = await put(key, body, {
      access: "public",
      contentType,
      // Public URLs are guessable by design; a random suffix stops enumeration
      // of one institution's media from the URL of another.
      addRandomSuffix: true,
    });
    return { key: blob.url, size: body.byteLength, contentType };
  },

  async deletePublic(key) {
    await del(key).catch(() => undefined);
  },

  async getPublic(key) {
    try {
      const response = await fetch(key);
      if (!response.ok) return null;

      const body = Buffer.from(await response.arrayBuffer());
      return {
        body,
        contentType: response.headers.get("content-type") || "application/octet-stream",
      };
    } catch {
      return null;
    }
  },
};
