import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { generateDevKeys } from "./scripts/dev-keys.ts";
import { TEST_AUD, TEST_GATEWAY_API_KEY, TEST_GATEWAY_BASE_URL, TEST_KID, TEST_TEAM_DOMAIN } from "./test/constants.ts";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "migrations"),
      );
      // 每次執行產生一組測試用 RSA 金鑰：公鑰 JWKS 給 App Worker 驗簽，私鑰只給測試簽發 JWT
      const { publicJwk, privateJwk } = await generateDevKeys(TEST_KID);
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        // 測試專用 binding：讓 setup 檔能把 drizzle-kit 產生的 migration 套到本機 D1
        miniflare: {
          d1Databases: ["MIGRATION_DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
            ACCESS_AUD: TEST_AUD,
            ACCESS_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
            GOOGLE_CLIENT_ID: "test-google-client-id",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
            LINE_CHANNEL_ID: "test-line-channel-id",
            LINE_CHANNEL_SECRET: "test-line-channel-secret",
            GATEWAY_BASE_URL: TEST_GATEWAY_BASE_URL,
            GATEWAY_API_KEY: TEST_GATEWAY_API_KEY,
            TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateJwk),
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // 整合測試每例都在 Workers 執行環境內建表、下單、寫 D1；全套並行時單例常超過預設 5 秒，統一放寬避免偶發逾時
    testTimeout: 30_000,
    coverage: {
      // workers pool 不支援 V8 coverage，必須用 istanbul（developers.cloudflare.com/workers/testing/vitest-integration/known-issues/）
      provider: "istanbul",
      reporter: ["text-summary", "text", "json-summary", "lcov"],
      // 覆蓋率 80% 以上，低於門檻時 CI 失敗
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
