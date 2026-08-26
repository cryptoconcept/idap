import type { Platform } from "@/lib/constants";
import type { PlatformAdapter } from "./types";
// Side-effect import: `passpercent.ts` calls `registerAdapter` at module
// scope. It also imports `registerAdapter` back from this file — a
// deliberate small cycle. It's safe because `registerAdapter` is a hoisted
// function declaration and ES module named exports are live bindings, so by
// the time `passpercent.ts`'s top-level call actually runs, the binding it
// closed over already resolves to the real function.
import "./passpercent";

/**
 * One registry, one lookup point. Adapters register themselves as a
 * top-level side effect of the module that defines them (see
 * `passpercent.ts`); this file imports that module so the side effect runs.
 * FeesBasket's adapter registers the same way once its own module lands.
 */
const registry = new Map<Platform, PlatformAdapter>();

export function registerAdapter(adapter: PlatformAdapter): void {
  registry.set(adapter.platform, adapter);
}

/** Throws for a platform with no registered adapter — the caller (the sync
 * service) gets a single place that fails loudly instead of a silent no-op. */
export function adapterFor(platform: Platform): PlatformAdapter {
  const adapter = registry.get(platform);
  if (!adapter) {
    throw new Error(`No connector adapter is registered for platform "${platform}"`);
  }
  return adapter;
}
