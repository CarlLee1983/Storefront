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
    // 空店面 spec 斷言「店裡沒有任何上架商品」（首頁不出現精選區與分類方塊、導覽列沒有特價）：serve.ts 每次重建狀態、不預先放商品，
    // 所以要在任何會上架商品的 spec 之前單獨跑完；chromium 依賴它，其他 project 再經由 chromium 間接排在它之後
    // 取捨：empty-store 失敗時，下游所有 project 都會被跳過（已接受，換取「最先、狀態乾淨」的保證）
    { name: "empty-store", testMatch: "empty-store.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium", testIgnore: ["empty-store.spec.ts", "listing.spec.ts", "sale.spec.ts", "homepage*.spec.ts", "main-flow.spec.ts", "shipping-rates.spec.ts", "contact-mailbox.spec.ts"], dependencies: ["empty-store"], use: { ...devices["Desktop Chrome"] } },
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
    // 運費費率是全域狀態：調整期間同時進行的結帳 spec 金額會失準，所以等其他 spec 全跑完才序列執行，結束前還原費率
    { name: "shipping-rates", testMatch: "shipping-rates.spec.ts", dependencies: ["chromium", "listing", "home", "sale", "main-flow"], fullyParallel: false, workers: 1, use: { ...devices["Desktop Chrome"] } },
    // 信件投遞失敗演練是全域狀態（mail_controls）：開啟期間其他 spec 的通知都會投遞失敗、信箱沒有信，所以不與它們並行；
    // 同檔的測試依序執行（見 contact-mailbox.spec.ts），排在所有 project 之後
    { name: "contact-mailbox", testMatch: "contact-mailbox.spec.ts", dependencies: ["chromium", "listing", "home", "sale", "main-flow", "shipping-rates"], fullyParallel: false, workers: 1, use: { ...devices["Desktop Chrome"] } },
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
