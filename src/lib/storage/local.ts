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
};
