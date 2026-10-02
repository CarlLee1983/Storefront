#!/usr/bin/env node
// Run only against a freshly seeded, isolated E2E harness. All artifacts stay beside this script.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const worktree = resolve(process.argv[2] ?? "");
if (!existsSync(join(worktree, "e2e/harness/session-cookie.ts"))) {
  throw new Error("Pass the integrated worktree as the first argument.");
}
const output = resolve(process.argv[3] ?? join(import.meta.dirname, "final"));
mkdirSync(output, { recursive: true });
const base = process.env.STOREFRONT_BASE_URL ?? "http://localhost:8790";
const gateway = process.env.STOREFRONT_GATEWAY_URL ?? "http://localhost:8791";
const port = Number(process.env.LH_CDP_PORT ?? "19229");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const lighthousePath = "/Users/carl/.npm/_npx/1722e863ebfd623b/node_modules/lighthouse/cli/index.js";
const requireFromE2e = createRequire(join(worktree, "e2e/package.json"));
const { chromium } = requireFromE2e("@playwright/test");
const AxeBuilder = requireFromE2e("@axe-core/playwright").default;
const { memberSessionCookie } = await import(pathToFileURL(join(worktree, "e2e/harness/session-cookie.ts")));

const manifest = {
  worktree, base, gateway, startedAt: new Date().toISOString(),
  gitSha: execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  gitStatus: execFileSync("git", ["-C", worktree, "status", "--short"], { encoding: "utf8" }).trim(),
  scriptSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  tools: { node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(), bun: process.versions.bun ?? null, lighthouse: execFileSync("node", [lighthousePath, "--version"], { encoding: "utf8" }).trim() },
  browser: { executable: chromePath, port, profile: join(import.meta.dirname, "chrome-final") },
  lighthouse: { executable: lighthousePath, categories: ["performance", "accessibility"], mode: "Navigation", formFactor: "mobile", throttlingMethod: "simulate", disableStorageReset: true },
  seed: "Expected fresh local E2E D1/R2 with demo catalog: 4 categories, 32 listed products; fake E2E identities only",
  pages: [], reports: [], errors: [],
};
const saveManifest = () => writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const run = (command, args, logPath) => new Promise((done) => {
  const log = createWriteStream(logPath);
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.on("error", (error) => { log.end(); done({ code: -1, error: String(error) }); });
  child.on("close", (code) => { log.end(); done({ code }); });
});
const waitForChrome = async (child) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Chrome exited: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const version = await response.json();
      if (String(version.Browser).startsWith("Chrome/")) return version.Browser;
    } catch { /* starting */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("Chrome CDP did not become ready.");
};

const chromeLog = createWriteStream(join(output, "chrome.log"));
const chrome = spawn(chromePath, [
  "--headless=new", `--user-data-dir=${manifest.browser.profile}`,
  `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stdout.pipe(chromeLog, { end: false }); chrome.stderr.pipe(chromeLog, { end: false });
let browser;
try {
  manifest.browser.version = await waitForChrome(chrome);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();
  await context.addCookies([memberSessionCookie()]);
  await page.goto(`${base}/products`);
  assert((await page.locator("main").innerText()).includes("共 32 件商品"), "Expected 32 listed demo products.");
  await page.goto(`${base}/`);
  assert(await page.getByRole("region", { name: "依空間選物" }).getByRole("listitem").count() === 4, "Expected four listed demo categories.");
  manifest.seedVerified = true;
  await page.goto(`${base}/search?q=luma`);
  const productHref = await page.getByRole("link", { name: "Luma 弧形單椅", exact: true }).first().getAttribute("href");
  assert(/^\/products\/\d+$/.test(productHref ?? ""), `Luma detail unavailable: ${productHref}`);
  manifest.productPath = productHref;

  // Place and pay for one real order through the customer and fake gateway UIs.
  await page.goto(`${base}${productHref}`);
  await page.locator('input[name="quantity"][type="number"]').fill("1");
  await page.getByRole("button", { name: /加入購物車/ }).first().click();
  await page.goto(`${base}/cart`);
  assert((await page.locator("main").innerText()).includes("Luma 弧形單椅"), "Cart is not populated before checkout.");
  await page.getByRole("link", { name: "前往結帳" }).click();
  assert(new URL(page.url()).pathname === "/checkout", `Unexpected checkout URL: ${page.url()}`);
  await page.getByLabel("收件人姓名").fill("E2E 收件人");
  await page.getByLabel("收件人電話").fill("0912345678");
  await page.getByLabel("收件地址").fill("台北市中正區（E2E 示意地址）");
  await page.getByRole("button", { name: "送出訂單" }).click();
  await page.waitForURL(/\/orders\/\d+\?placed=1$/, { timeout: 20_000 });
  const orderPath = new URL(page.url()).pathname;
  assert((await page.locator("main").innerText()).includes("訂單狀態：待付款"), "Order was not pending payment.");
  await page.getByRole("button", { name: "前往付款" }).click();
  assert(page.url().startsWith(`${gateway}/pay/`), `Unexpected gateway URL: ${page.url()}`);
  await page.getByRole("radio", { name: "成功" }).check();
  await page.getByRole("radio", { name: "立即回呼" }).check();
  await page.getByRole("button", { name: "送出" }).click();
  await page.waitForURL(`${base}${orderPath}`, { timeout: 20_000 });
  assert((await page.locator("main").innerText()).includes("訂單狀態：已付款"), "Order was not paid.");
  manifest.orderPath = orderPath;

  // Restore the same visible quantity-two cart used for the original five-route baseline.
  await page.goto(`${base}${productHref}`);
  await page.locator('input[name="quantity"][type="number"]').fill("2");
  await page.getByRole("button", { name: /加入購物車/ }).first().click();
  await page.goto(`${base}/cart`);
  const cart = await page.evaluate(() => JSON.parse(localStorage.getItem("storefront.cart") ?? "null"));
  assert(cart?.lines?.length === 1 && cart.lines[0]?.name === "Luma 弧形單椅" && cart.lines[0]?.quantity === 2, `Cart mismatch: ${JSON.stringify(cart)}`);
  manifest.cart = { name: "Luma 弧形單椅", quantity: 2, productId: cart.lines[0].productId };

  const screenshotPages = [
    ["home", "/", "靜物"], ["category", "/categories/living", "客廳"],
    ["detail", productHref, "Luma 弧形單椅"], ["cart", "/cart", "Luma 弧形單椅"],
    ["checkout", "/checkout", "Luma 弧形單椅"], ["orders-detail", orderPath, "已付款"],
    ["orders-list", "/orders", `訂單 #${orderPath.split("/").at(-1)}`],
    ["sale", "/sale", "NT$"], ["content-about", "/about", "靜物"],
  ];
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [name, path, expected] of screenshotPages) {
    for (const width of [375, 1280]) {
      const height = width === 375 ? 812 : 900;
      const record = { name, path, width, height, png: `${name}-${width}.png` };
      manifest.pages.push(record); saveManifest();
      try {
        await page.setViewportSize({ width, height });
        const response = await page.goto(`${base}${path}`);
        assert(response?.status() === 200, `${name} HTTP ${response?.status()}`);
        assert(page.url() === `${base}${path}`, `${name} final URL ${page.url()}`);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(async (image) => {
            image.loading = "eager";
            await image.decode().catch(() => undefined);
          }));
        });
        if (name === "home") {
          assert((await page.locator("#hero-status").textContent())?.trim() === "1 / 3", "Home hero did not remain on slide 1.");
        }
        const mainText = await page.locator("main").innerText();
        assert(mainText.includes(expected), `${name} missing populated content: ${expected}`);
        record.finalUrl = page.url();
        record.overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        record.axeViolations = (await new AxeBuilder({ page }).analyze()).violations.map(({ id, impact, nodes }) => ({ id, impact, count: nodes.length }));
        await page.screenshot({ path: join(output, record.png), fullPage: true });
        if (record.overflow || record.axeViolations.length) {
          manifest.errors.push(`${name}-${width}: overflow=${record.overflow}, axe=${record.axeViolations.map(v => v.id).join(",")}`);
        }
      } catch (error) {
        record.error = String(error);
        manifest.errors.push(`${name}-${width}: ${error}`);
        await page.screenshot({ path: join(output, record.png), fullPage: true }).catch(() => undefined);
      }
      saveManifest();
    }
  }
  await page.emulateMedia({ reducedMotion: null });
  await browser.close(); browser = undefined; // Lighthouse must have sole control of this Chrome transport.

  const lighthousePages = [
    ["home", "/"], ["detail", productHref], ["cart", "/cart"],
    ["category", "/categories/living"], ["search", "/search?q=luma"],
    ["checkout", "/checkout"], ["orders", orderPath], ["sale", "/sale"],
  ];
  for (const [name, path] of lighthousePages) {
    const record = { name, path, html: `${name}.report.html`, json: `${name}.report.json`, log: `${name}.lighthouse.log` };
    manifest.reports.push(record); saveManifest();
    const result = await run("node", [lighthousePath, `${base}${path}`,
      `--port=${port}`, "--output=html", "--output=json", `--output-path=${join(output, name)}`,
      "--only-categories=performance,accessibility", "--form-factor=mobile", "--throttling-method=simulate",
      "--disable-storage-reset", "--quiet",
    ], join(output, record.log));
    record.exitCode = result.code;
    if (existsSync(join(output, record.json))) {
      try {
        const report = JSON.parse(readFileSync(join(output, record.json), "utf8"));
        record.requestedUrl = report.requestedUrl;
        record.finalUrl = report.finalUrl;
        record.performance = report.categories?.performance?.score == null ? null : Math.round(report.categories.performance.score * 100);
        record.accessibility = report.categories?.accessibility?.score == null ? null : Math.round(report.categories.accessibility.score * 100);
        record.fetchTime = report.fetchTime;
        record.lighthouseVersion = report.lighthouseVersion;
        record.chromeUserAgent = report.environment?.hostUserAgent;
        record.runtimeError = report.runtimeError;
      } catch (error) {
        record.parseError = String(error);
      }
    }
    if (result.code !== 0 || record.finalUrl !== `${base}${path}` || !existsSync(join(output, record.html))) {
      manifest.errors.push(`${name} Lighthouse failed or URL mismatch: ${JSON.stringify(record)}`);
    }
    saveManifest();
  }
} catch (error) {
  manifest.errors.push(String(error?.stack ?? error));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  chrome.kill("SIGTERM"); chromeLog.end();
  manifest.finishedAt = new Date().toISOString();
  saveManifest();
  // This file can accompany reports and PNGs in repository docs; it excludes profile paths and cookies.
  const publicManifest = {
    gitSha: manifest.gitSha, gitStatus: manifest.gitStatus, scriptSha256: manifest.scriptSha256,
    tools: manifest.tools, browserVersion: manifest.browser.version, lighthouse: {
      categories: manifest.lighthouse.categories, mode: manifest.lighthouse.mode,
      formFactor: manifest.lighthouse.formFactor, throttlingMethod: manifest.lighthouse.throttlingMethod,
      disableStorageReset: manifest.lighthouse.disableStorageReset,
    },
    startedAt: manifest.startedAt, finishedAt: manifest.finishedAt,
    seed: manifest.seed, seedVerified: manifest.seedVerified ?? false, cart: manifest.cart,
    orderPath: manifest.orderPath, productPath: manifest.productPath,
    pages: manifest.pages.map(({ name, path, width, height, png, finalUrl, overflow, axeViolations, error }) => ({ name, path, width, height, png, finalUrl, overflow, axeViolations, error })),
    reports: manifest.reports.map(({ name, path, html, json, exitCode, requestedUrl, finalUrl, performance, accessibility, fetchTime, lighthouseVersion, chromeUserAgent, runtimeError, parseError }) => ({ name, path, html, json, exitCode, requestedUrl, finalUrl, performance, accessibility, fetchTime, lighthouseVersion, chromeUserAgent, runtimeError, parseError })),
    issueCount: manifest.errors.length,
  };
  writeFileSync(join(output, "public-manifest.json"), `${JSON.stringify(publicManifest, null, 2)}\n`);
  const rows = manifest.pages.map(p => `<tr><td>${p.name}</td><td>${p.width}</td><td><a href="${p.png}"><img src="${p.png}" alt="${p.name} ${p.width}px full-page screenshot"><br>Full PNG</a></td><td>${p.overflow ?? ""}</td><td>${p.axeViolations?.length ?? p.error ?? ""}</td></tr>`).join("\n");
  const reportRows = manifest.reports.map(r => `<tr><td>${r.name}</td><td>${r.performance ?? ""}</td><td>${r.accessibility ?? ""}</td><td><a href="${r.html}">HTML</a> / <a href="${r.json}">JSON</a></td><td>${r.finalUrl ?? ""}</td></tr>`).join("\n");
  writeFileSync(join(output, "review.html"), `<!doctype html><meta charset="utf-8"><title>Storefront #91 evidence</title><style>body{font:16px system-ui;margin:2rem;max-width:85rem}table{border-collapse:collapse;width:100%;margin-bottom:2rem}td,th{border:1px solid #bbb;padding:.45rem;text-align:left}a{color:#064cb3}img{max-width:375px;width:100%;height:auto}</style><h1>#91 final capture</h1><p>See <a href="public-manifest.json">public-manifest.json</a> for run settings and results.</p><h2>Screenshots</h2><table><tr><th>Page</th><th>Width</th><th>Image</th><th>Overflow</th><th>Axe issues</th></tr>${rows}</table><h2>Lighthouse</h2><table><tr><th>Page</th><th>Performance</th><th>Accessibility</th><th>Reports</th><th>Final URL</th></tr>${reportRows}</table>`);
}
if (manifest.errors.length) {
  console.error(`Capture finished with ${manifest.errors.length} issue(s); see ${join(output, "manifest.json")}`);
  process.exitCode = 1;
} else {
  console.log(`Capture complete: ${manifest.pages.length} screenshots, ${manifest.reports.length} Lighthouse routes. ${join(output, "review.html")}`);
}
