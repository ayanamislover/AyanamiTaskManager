import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/**/*.{test,spec}.ts"],
    exclude: ["apps/desktop/e2e/**", "**/dist/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
