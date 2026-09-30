import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { TEST_API_KEY, TEST_WEBHOOK_SECRET } from "./test/constants.ts";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            GATEWAY_API_KEY: TEST_API_KEY,
            GATEWAY_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    coverage: {
      // workers pool 不支援 V8 coverage，必須用 istanbul
      provider: "istanbul",
      reporter: ["text-summary", "text", "json-summary", "lcov"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
