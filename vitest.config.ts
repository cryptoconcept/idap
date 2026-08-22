import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(root, "src"),
      // `server-only` throws outside a React Server Component. The modules under
      // test are server modules by construction, so it is stubbed here.
      "server-only": resolve(root, "tests/helpers/server-only-stub.ts"),
      // Pulled in transitively by session helpers; only the JWT parts are tested.
      "next/headers": resolve(root, "tests/helpers/next-headers-stub.ts"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["tests/helpers/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Each integration file gets its own database, so files may run in parallel,
    // but tests inside a file share state and must not.
    fileParallelism: true,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
