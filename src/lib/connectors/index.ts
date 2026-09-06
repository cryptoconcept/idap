import type { Platform } from "@/lib/constants";
import type { PlatformAdapter } from "./types";
// Side-effect import: `passpercent.ts` calls `registerAdapter` at module
// scope. It also imports `registerAdapter` back from this file — a
// deliberate small cycle. `registerAdapter` itself is safe to call this early
// because it's a hoisted function declaration and ES module named exports are
// live bindings. The registry it writes into is NOT safe to build the same
// way, though (Task 8 fix — see the comment below).
import "./passpercent";
import "./edufleet";
import "./scholarship-hub";

/**
 * One registry, one lookup point. Adapters register themselves as a
 * top-level side effect of the module that defines them (see
 * `passpercent.ts`); this file imports that module so the side effect runs.
 * FeesBasket's adapter registers the same way once its own module lands.
 *
 * The map is cached on `globalThis` (the same pattern `connectToDatabase`
 * uses) and created lazily inside `getRegistry()`, rather than a plain
 * module-scope `const` initialized at the top of this file. That distinction
 * is load-bearing, not stylistic: whoever imports `@/lib/connectors` (this
 * file) *first* — before anything else has already loaded `./passpercent` —
 * hits `import "./passpercent"` above, which runs passpercent.ts's own
 * top-level `registerAdapter(passpercentAdapter)` call BEFORE this module's
 * own body (anything below its imports) has executed, because ES module
 * imports are linked and evaluated ahead of the importing module's own
 * statements, regardless of where a `const` sits in the file. A plain
 * `const registry = new Map()` here would still be in its temporal dead zone
 * at that moment, so that circular call would throw "Cannot access
 * 'registry' before initialization" — which is exactly what happened the
 * first time something actually imported this module directly (Task 8's
 * `connection.service.ts` and its tests; nothing before Task 8 did).
 * Reading/creating the map lazily inside a function body sidesteps this
 * entirely, since the function only runs when called, never at module link
 * time.
 */
function getRegistry(): Map<Platform, PlatformAdapter> {
  // Deliberately no module-scope `const`/`let` backs this — see the doc
  // comment above. `store` is a function-local binding created fresh each
  // call, so it carries none of the TDZ risk a module-scope one would.
  const store = globalThis as unknown as {
    __idapConnectorRegistry?: Map<Platform, PlatformAdapter>;
  };
  return (store.__idapConnectorRegistry ??= new Map<Platform, PlatformAdapter>());
}

export function registerAdapter(adapter: PlatformAdapter): void {
  getRegistry().set(adapter.platform, adapter);
}

/** Throws for a platform with no registered adapter — the caller (the sync
 * service) gets a single place that fails loudly instead of a silent no-op. */
export function adapterFor(platform: Platform): PlatformAdapter {
  const adapter = getRegistry().get(platform);
  if (!adapter) {
    throw new Error(`No connector adapter is registered for platform "${platform}"`);
  }
  return adapter;
}
