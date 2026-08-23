import "server-only";
import { del, get, put } from "@vercel/blob";
import type { StorageAdapter } from "./types";

/**
 * Vercel Blob adapter for production.
 *
 * Uploads are stored with `access: "private"`, so a blob URL alone is not
 * enough to read a document: the read goes through the app's authenticated,
 * tenant-checked route. `put` returns the blob's own URL, which becomes the
 * stored handle — never assume the key you passed in is the key you read back
 * with.
 */
export const blobStorageAdapter: StorageAdapter = {
  async put({ key, body, contentType }) {
    const blob = await put(key, body, {
      access: "private",
      contentType,
      // The key is already unique (a generated ObjectId), and a stable handle
      // makes the stored reference predictable.
      addRandomSuffix: false,
    });

    return { key: blob.url, size: body.byteLength, contentType };
  },

  async get(key) {
    try {
      const result = await get(key, { access: "private" });
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
    await del(key).catch(() => undefined);
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
};
