/**
 * Minimal stand-in for `next/headers`. The tests exercise the pure token
 * functions; anything that genuinely needs a request context is covered by
 * `scripts/acceptance-test.sh` against a running server instead.
 */
const store = new Map<string, string>();

export async function cookies() {
  return {
    get: (name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
    set: (name: string, value: string) => {
      store.set(name, value);
    },
    delete: (name: string) => {
      store.delete(name);
    },
  };
}

export async function headers() {
  return new Headers();
}
