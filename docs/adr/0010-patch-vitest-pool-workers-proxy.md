---
status: accepted
---

# 以 bun patch 修補 vitest-pool-workers 的 Proxy 疊加

`@cloudflare/vitest-pool-workers` 0.22.0 的 `createProxyPrototypeClass` 每建構一次 entrypoint 實例就把 `Class.prototype` 再包一層 Proxy，同一測試檔內第 n 次 RPC 要穿過 n 層，耗時呈二次方成長；App 全套測試因此從約 2 分鐘拉長到約 10 分鐘，並在全套並行時偶發 30 秒逾時。0.22.0 已是 npm 最新版，沒有可升級的修正版，所以以 `bun patch` 改為只包一次（`patches/` 與根 `package.json` 的 `patchedDependencies`）。

這選擇了自行維護一份依賴修補，換取可靠的測試閘門；替代方案是拉長逾時或拆檔，但那只是延後問題。上游修正後應直接升級並移除這份 patch，不要保留。

**Falsified if:** 根 `package.json` 的 `@cloudflare/vitest-pool-workers` 升級到已修正 Proxy 疊加的版本（此時應刪除 patch），或 `patches/@cloudflare%2Fvitest-pool-workers@0.22.0.patch` 在升級後無法套用。
