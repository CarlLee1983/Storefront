import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, WEB_SERVER_TIMEOUT_MS } from "./harness/constants";

export default defineConfig({
  testDir: "tests",
  forbidOnly: !!process.env.CI,
  // 主流程只有一條，重試只會掩蓋接線問題
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", testIgnore: ["listing.spec.ts", "sale.spec.ts", "homepage*.spec.ts", "main-flow.spec.ts"], use: { ...devices["Desktop Chrome"] } },
    // 列表 spec 會上架 31 件商品，擠掉首頁第一頁（24 件）：等其他 spec 全跑完才執行，不與它們並行
    { name: "listing", testMatch: "listing.spec.ts", dependencies: ["chromium"], use: { ...devices["Desktop Chrome"] } },
    // 首頁 spec 會標精選、上架商品，擠掉 /products 第一頁：同樣等其他 spec 跑完才執行。
    // listing 與 home 都只依賴 chromium，兩者之間會並行：home 只靠自己標的精選（見 harness/admin-featured.ts 的名額上限），不受 listing 的 31 件商品影響
    { name: "home", testMatch: "homepage*.spec.ts", dependencies: ["chromium"], use: { ...devices["Desktop Chrome"] } },
    // 特價 spec 斷言「有沒有特價商品」這個全域狀態（導覽列入口、/sale 空狀態）：等其他 spec 全跑完才執行，不與它們並行；
    // 也排在 listing 與 home 之後，因為它們新增的商品會影響列表類斷言
    { name: "sale", testMatch: "sale.spec.ts", dependencies: ["chromium", "listing", "home"], use: { ...devices["Desktop Chrome"] } },
    // 主流程會建立分類、上架 25 件商品、標原價與精選：會讓 sale 的「沒有特價商品」與首頁精選名額失準，所以排在所有 project 之後單獨執行。
    // 它只依賴自己建立的資料，不受前面 project 留下的商品影響
    { name: "main-flow", testMatch: "main-flow.spec.ts", dependencies: ["chromium", "listing", "home", "sale"], use: { ...devices["Desktop Chrome"] } },
  ],
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
