/**
 * 示範資料 seed（#59）：讀 demo/catalog.json，以瀏覽器操作後台，把示範分類與商品灌進本機或 preview。
 * 用法見 README「示範資料」。目標在開瀏覽器之前就驗證，production 一律拒絕，因此拒絕時沒有任何寫入。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import * as admin from "./admin-ui";
import { loadCatalog, type DemoCatalog } from "./catalog";
import { resolveSeedTarget, type SeedTarget } from "./target";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
/** preview 用的 Chrome 設定檔：保留 Access 登入，重跑時不必每次重新登入。位於已 gitignore 的 .wrangler/ 下。 */
const PREVIEW_PROFILE_DIR = resolve(REPO_ROOT, ".wrangler/seed-chrome-preview");
const LOGIN_TIMEOUT_MS = 15 * 60_000;

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`seed 失敗：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main(args: string[]) {
  const target = resolveSeedTarget(args);
  const catalog = loadCatalog();
  console.log(`seed 目標：${target.name}（${target.baseUrl}）；${catalog.categories.length} 個分類、${catalog.products.length} 件商品。`);

  const context = target.interactiveLogin ? await openPreviewContext(target) : await openLocalContext(target);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    if (target.interactiveLogin) await waitForAccessLogin(page, target);
    await admin.assertStorefrontAdmin(page);
    await seedCategories(page, catalog);
    await seedProducts(page, catalog);
    await report(page, catalog);
  } finally {
    await context.close();
  }
}

/**
 * 本機：`bun run admin:dev-token` 產生的 ACCESS_DEV_JWT 以 Access header 帶上。`bun run dev` 不帶也會自己讀，
 * 但 `bun run preview`（正式建置）只認 header；統一帶上，兩種本機伺服器都適用。
 */
async function openLocalContext(target: SeedTarget): Promise<BrowserContext> {
  const jwt = readDevJwt();
  if (!jwt) throw new Error("apps/web/.dev.vars 沒有 ACCESS_DEV_JWT：請先執行 bun run admin:dev-token，並重新啟動本機伺服器。");
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: target.baseUrl, extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": jwt } });
  context.on("close", () => void browser.close());
  return context;
}

function readDevJwt(): string | undefined {
  const file = resolve(REPO_ROOT, "apps/web/.dev.vars");
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return /^ACCESS_DEV_JWT='?([^'\n]+)'?$/m.exec(content)?.[1];
}

/** preview：開有畫面的 Chrome，由 owner 手動登入 Cloudflare Access（App 驗管理員要求 email claim，不用 service token，見 #51）。 */
async function openPreviewContext(target: SeedTarget): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PREVIEW_PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    baseURL: target.baseUrl,
    viewport: null,
    // 少了「受自動化軟體控制」的旗標，部分登入頁才不會拒絕這個瀏覽器
    ignoreDefaultArgs: ["--enable-automation"],
  });
}

async function waitForAccessLogin(page: Page, target: SeedTarget) {
  await page.goto("/admin");
  console.log(`請在開啟的 Chrome 完成 Cloudflare Access 登入（最多等 ${LOGIN_TIMEOUT_MS / 60_000} 分鐘），登入後 seed 會自動接手。`);
  await page.waitForURL((url) => url.origin === target.baseUrl && url.pathname === "/admin", { timeout: LOGIN_TIMEOUT_MS });
  console.log("已登入後台，開始寫入示範資料。");
}

async function seedCategories(page: Page, catalog: DemoCatalog) {
  const existingSlugs = new Set((await admin.listCategories(page)).map((c) => c.slug));
  for (const category of catalog.categories) {
    if (existingSlugs.has(category.slug)) continue;
    await admin.createCategory(page, category);
    console.log(`建立分類：${category.name}（${category.slug}）`);
  }
  const categories = await admin.listCategories(page);
  for (const category of catalog.categories) {
    const current = categories.find((c) => c.slug === category.slug);
    if (!current) throw new Error(`建立後仍找不到分類：${category.slug}`);
    if (current.hasImage) continue;
    await admin.uploadCategoryImage(page, current.id, category.imageFile);
    console.log(`上傳分類圖片：${category.name}`);
  }
}

async function seedProducts(page: Page, catalog: DemoCatalog) {
  const existingNames = new Set((await admin.listProducts(page)).map((p) => p.name));
  for (const product of catalog.products) {
    if (existingNames.has(product.name)) continue;
    await admin.createProduct(page, product);
    console.log(`建立商品：${product.name}`);
  }

  // 分類以代稱判斷存在，名稱可能已在後台被改過：編輯頁的下拉選單用後台現在的名稱
  const categoryNames = new Map((await admin.listCategories(page)).map((c) => [c.slug, c.name]));
  const products = await admin.listProducts(page);
  for (const product of catalog.products) {
    const current = products.find((p) => p.name === product.name);
    if (!current) throw new Error(`建立後仍找不到商品：${product.name}`);
    const changes: string[] = [];
    const { saved, uploaded } = await admin.syncProductDetails(page, current.id, product, categoryNames.get(product.category)!);
    if (saved) changes.push("更新說明／售價／原價／分類");
    if (uploaded > 0) changes.push(`上傳 ${uploaded} 張圖片`);
    // 只補足到清單的在庫數；已經比清單多（例如管理員補過貨）就不動，也不會因為有保留而調降失敗
    if (current.onHand < product.onHand) {
      await admin.adjustStock(page, product.name, product.onHand - current.onHand);
      changes.push(`庫存 +${product.onHand - current.onHand}`);
    }
    if (current.featured !== product.featured) {
      await admin.setFeatured(page, product.name, product.featured);
      changes.push(product.featured ? "標為精選" : "取消精選");
    }
    if (!current.listed) {
      await admin.relist(page, product.name);
      changes.push("上架");
    }
    if (changes.length > 0) console.log(`${product.name}：${changes.join("、")}`);
  }
}

async function report(page: Page, catalog: DemoCatalog) {
  const slugs = new Set(catalog.categories.map((c) => c.slug));
  const names = new Set(catalog.products.map((p) => p.name));
  const categories = (await admin.listCategories(page)).filter((c) => slugs.has(c.slug));
  const products = (await admin.listProducts(page)).filter((p) => names.has(p.name));
  const listed = products.filter((p) => p.listed).length;
  console.log(`完成：示範分類 ${categories.length} 個、示範商品 ${products.length} 件（上架中 ${listed} 件）。`);
  if (categories.length !== slugs.size || products.length !== names.size || listed !== names.size) {
    throw new Error("後台的示範資料數量與清單不一致，請檢查上方的紀錄。");
  }
}
