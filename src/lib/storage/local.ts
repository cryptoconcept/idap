import "server-only";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { StorageAdapter } from "./types";

/**
 * Development adapter. Files live outside `public/` so nothing is ever served
 * statically — reads go through the authenticated document route.
 *
 * The dynamic paths here make Turbopack emit a "Dynamic filesystem access"
 * build warning. That is expected for a disk-backed adapter, and goes away once
 * this is swapped for object storage in production.
 */
const ROOT = resolve(process.env.UPLOAD_DIR ?? join(process.cwd(), ".uploads"));

/** Rejects any key that would escape the storage root. */
function resolveKey(key: string): string {
  const target = resolve(ROOT, key);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    throw new Error("Invalid storage key");
  }
  return target;
}

const CONTENT_TYPE_SUFFIX = ".content-type";

/**
 * `putPublic` returns a `/api/media/`-prefixed key (see below) — that is the
 * value every caller actually persists and hands back in (`ResultService`
 * stores `stored.key` verbatim). Every OTHER consumer of that stored key must
 * strip the prefix back off before resolving it against `PUBLIC_ROOT`, or the
 * escape guard in `resolvePublicKey` rejects it as looking absolute. A raw,
 * unprefixed key (no leading `/api/media/`) passes through unchanged, so both
 * shapes keep working. Centralized here — once in `deletePublic`, once
 * missing from `getPublic` (fix round 2, F2) — so the two can never drift
 * apart on this again.
 */
function stripPublicKeyPrefix(key: string): string {
  return key.replace(/^\/api\/media\//, "");
}

/**
 * Public media lives under a distinct root from the private `.uploads` tree
 * above, so the unauthenticated `/api/media` route can never reach a private
 * document even if its key-escape check were somehow bypassed.
 */
const PUBLIC_ROOT = resolve(process.env.PUBLIC_UPLOAD_DIR ?? join(process.cwd(), ".uploads-public"));

/** Rejects any key that would escape the public media root. */
function resolvePublicKey(key: string): string {
  const target = resolve(PUBLIC_ROOT, key);
  if (target !== PUBLIC_ROOT && !target.startsWith(PUBLIC_ROOT + sep)) {
    throw new Error("Invalid storage key");
  }
  return target;
}

export const localStorageAdapter: StorageAdapter = {
  async put({ key, body, contentType }) {
    const target = resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    await writeFile(`${target}${CONTENT_TYPE_SUFFIX}`, contentType, "utf8");
    return { key, size: body.byteLength, contentType };
  },

  async get(key) {
    const target = resolveKey(key);
    try {
      const [body, contentType] = await Promise.all([
        readFile(target),
        readFile(`${target}${CONTENT_TYPE_SUFFIX}`, "utf8").catch(
          () => "application/octet-stream",
        ),
      ]);
      return { body, contentType: contentType.trim() };
    } catch {
      return null;
    }
  },

  async delete(key) {
    const target = resolveKey(key);
    await Promise.all([
      unlink(target).catch(() => undefined),
      unlink(`${target}${CONTENT_TYPE_SUFFIX}`).catch(() => undefined),
    ]);
  },

  async putPublic({ key, body, contentType }) {
    const target = resolvePublicKey(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    await writeFile(`${target}${CONTENT_TYPE_SUFFIX}`, contentType, "utf8");
    return { key: `/api/media/${key}`, size: body.byteLength, contentType };
  },

  async deletePublic(key) {
    const target = resolvePublicKey(stripPublicKeyPrefix(key));
    await Promise.allSettled([unlink(target), unlink(`${target}${CONTENT_TYPE_SUFFIX}`)]);
  },

  async getPublic(key) {
    try {
      const target = resolvePublicKey(stripPublicKeyPrefix(key));
      const [body, contentType] = await Promise.all([
        readFile(target),
        readFile(`${target}${CONTENT_TYPE_SUFFIX}`, "utf8").catch(
          () => "application/octet-stream",
        ),
      ]);
      return { body, contentType: contentType.trim() };
    } catch {
      return null;
    }
  },
};
