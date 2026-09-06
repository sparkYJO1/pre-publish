import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test builds real git repositories on disk; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
