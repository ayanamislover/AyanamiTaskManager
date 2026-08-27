import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/**/*.{test,spec}.ts"],
    exclude: ["apps/desktop/e2e/**", "**/dist/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Windows 上大量并行 Git/SQLite 夹具会争抢临时目录与子进程，导致业务断言之外的
    // ETIMEDOUT/EPERM/ENOTEMPTY 假红；Linux CI 保持 Vitest 默认并发。
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
