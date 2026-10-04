import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * 掃描 axe 前先等頁面穩定：上傳按鈕在頁面腳本就緒前是停用的，啟用時還有顏色轉場，
 * axe 會量到轉場中途的顏色而誤報對比；等按鈕就緒、所有 CSS 動畫與轉場結束再掃。
 */
export async function analyzeWhenSettled(page: Page) {
  const upload = page.getByRole("button", { name: /^上傳(分類|商品)圖片$/ });
  if (await upload.count()) await expect(upload).toBeEnabled();
  // 被取消的動畫（例如轉場被新的樣式取代）的 finished 會以 AbortError 拒絕，視為已結束；無限循環的動畫不會結束，不等
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations()
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined))),
    // 暫停中或永遠不結束的動畫不能卡住測試：最多等 3 秒
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]));
  return new AxeBuilder({ page }).analyze();
}
