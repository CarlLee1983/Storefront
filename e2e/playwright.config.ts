import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, WEB_SERVER_TIMEOUT_MS } from "./harness/constants";

export default defineConfig({
  testDir: "tests",
  forbidOnly: !!process.env.CI,
  // 主流程只有一條，重試只會掩蓋接線問題
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // 每次重建 E2E 專用的狀態後，以建置產物跑 Web 與 App、另以一個行程跑模擬閘道（見 harness/serve.ts）
    command: "bun harness/serve.ts",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: WEB_SERVER_TIMEOUT_MS,
    // serve.ts 的子行程各自獨立成行程群組（detached），SIGKILL 殺不到它們；要給 SIGTERM 讓 serve.ts 自己清理
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    stdout: "pipe",
  },
});
