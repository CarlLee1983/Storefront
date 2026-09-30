import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  // 沒有用到 Sessions，省掉自動配置的 KV binding
  session: false,
  adapter: cloudflare({
    imageService: "passthrough",
    // 本機開發時把 App Worker 一起跑起來，Service Binding 才連得到；
    // D1 本機狀態與 apps/app 的 wrangler 指令共用同一個目錄
    auxiliaryWorkers: [{ configPath: "../app/wrangler.jsonc" }],
    persistState: { path: "../../.wrangler/state" },
  }),
});
