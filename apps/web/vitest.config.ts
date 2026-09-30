import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "text", "json-summary", "lcov"],
      // 覆蓋率 80% 以上，低於門檻時 CI 失敗
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
      // 只量 .ts 邏輯；.astro 頁面無法被 vitest 載入，E2E 在 #13
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
