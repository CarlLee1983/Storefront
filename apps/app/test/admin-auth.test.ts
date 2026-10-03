import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateRogueKey, mintAccessJwt } from "./access";
import { setNow } from "./clock";
import { resetDb } from "./db";
import { imageVariants } from "./images";

const NOW = Date.UTC(2030, 0, 1);
const NOW_SECONDS = NOW / 1000;
const UNAUTHORIZED = { ok: false, reason: "unauthorized" };
const REMOTE_TEAM_DOMAIN = "storefront-test.cloudflareaccess.com";

const app = exports.default;

// 每個管理 RPC 方法都必須先驗 JWT；用合法輸入呼叫，確保拒絕的原因只可能是身分
const adminCalls = (jwt: string) => ({
  reorderProductImages: () => app.reorderProductImages(jwt, { id: 1, imageIds: [] }),
  deleteProductImage: () => app.deleteProductImage(jwt, { id: 1, imageId: crypto.randomUUID() }),
  addProductImage: () => app.addProductImage(jwt, { id: 1, uploadId: crypto.randomUUID(), variants: imageVariants() }),
  createCategory: () => app.createCategory(jwt, { slug: "living", name: "客廳", description: "沙發" }),
  updateCategory: () => app.updateCategory(jwt, { id: 1, name: "客廳", description: "沙發" }),
  setCategoryImage: () => app.setCategoryImage(jwt, { id: 1, uploadId: crypto.randomUUID(), variants: imageVariants() }),
  deleteCategory: () => app.deleteCategory(jwt, { id: 1 }),
  getCategoryForAdmin: () => app.getCategoryForAdmin(jwt, { id: 1 }),
  listCategoriesForAdmin: () => app.listCategoriesForAdmin(jwt),
  createProduct: () => app.createProduct(jwt, { name: "馬克杯", description: "", priceTwd: 320 }),
  updateProduct: () => app.updateProduct(jwt, { id: 1, name: "馬克杯", description: "", priceTwd: 320 }),
  getProductForAdmin: () => app.getProductForAdmin(jwt, { id: 1 }),
  unlistProduct: () => app.unlistProduct(jwt, { id: 1 }),
  relistProduct: () => app.relistProduct(jwt, { id: 1 }),
  listProductsForAdmin: () => app.listProductsForAdmin(jwt),
  listOrdersForAdmin: () => app.listOrdersForAdmin(jwt, {}),
  exportOrdersForAdmin: () => app.exportOrdersForAdmin(jwt, {}),
  addOrderNote: () => app.addOrderNote(jwt, { orderId: 1, note: "電話確認過" }),
  getOrderForAdmin: () => app.getOrderForAdmin(jwt, { orderId: 1 }),
  shipOrder: () => app.shipOrder(jwt, { orderId: 1 }),
  confirmShipmentLoss: () => app.confirmShipmentLoss(jwt, { shipmentId: 1, lossKey: "k", items: [{ orderLineId: 1, quantity: 1 }] }),
  declareShipmentReturn: () => app.declareShipmentReturn(jwt, { shipmentId: 1, returnKey: "k", items: [{ orderLineId: 1, quantity: 1 }] }),
  recordShipmentReturnReceipt: () => app.recordShipmentReturnReceipt(jwt, { returnId: 1, items: [{ orderLineId: 1, receivedQuantity: 1 }] }),
  recordShipmentReturnInspection: () => app.recordShipmentReturnInspection(jwt, { returnId: 1, items: [{ orderLineId: 1, sellableQuantity: 1, damagedQuantity: 0 }] }),
});

async function expectAllRejected(jwt: string) {
  await resetDb();
  for (const [name, call] of Object.entries(adminCalls(jwt))) {
    expect(await call(), name).toEqual(UNAUTHORIZED);
  }
  // 拒絕之後沒有任何寫入
  expect(await app.listProducts()).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
}

describe("管理 RPC 的 Access JWT 驗證", () => {
  beforeEach(async () => {
    await resetDb();
    setNow(NOW);
  });

  it("合法的 JWT 通過", async () => {
    const result = await app.listProductsForAdmin(await mintAccessJwt());
    expect(result.ok).toBe(true);
  });

  it("偽造的 header 值（純 email、亂字串、未簽章 JSON）被拒絕", async () => {
    await expectAllRejected("admin@example.com");
    await expectAllRejected("not-a-jwt");
    const unsigned =
      btoa(JSON.stringify({ alg: "none" })) + "." +
      btoa(JSON.stringify({ email: "admin@example.com", aud: env.ACCESS_AUD })) + ".";
    await expectAllRejected(unsigned);
  });

  it("簽章無效（用別把金鑰簽）被拒絕", async () => {
    await expectAllRejected(await mintAccessJwt({ key: await generateRogueKey() }));
  });

  it("alg 不是 RS256（HS256）被拒絕", async () => {
    const secret = new TextEncoder().encode("x".repeat(32));
    const hmac = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    await expectAllRejected(await mintAccessJwt({ key: hmac, alg: "HS256" }));
  });

  it("aud 不符被拒絕", async () => {
    await expectAllRejected(await mintAccessJwt({ aud: "another-app" }));
  });

  it("iss 不符被拒絕", async () => {
    await expectAllRejected(await mintAccessJwt({ iss: "https://evil.cloudflareaccess.com" }));
  });

  it("已過期被拒絕：超過 30 秒容許誤差的拒絕，誤差內的接受（以注入的 Clock 判斷）", async () => {
    await expectAllRejected(await mintAccessJwt({ iat: NOW_SECONDS - 7200, exp: NOW_SECONDS - 3600 }));

    const withinTolerance = await mintAccessJwt({ iat: NOW_SECONDS - 7200, exp: NOW_SECONDS - 20 });
    expect((await app.listProductsForAdmin(withinTolerance)).ok).toBe(true);
  });

  it("沒有 email claim 被拒絕", async () => {
    await expectAllRejected(await mintAccessJwt({ email: null }));
  });
});

describe("Access 設定缺漏或不合法時 fail closed", () => {
  const original = { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, jwks: env.ACCESS_JWKS_JSON };

  beforeEach(async () => {
    await resetDb();
    setNow(NOW);
  });
  afterEach(() => {
    env.ACCESS_TEAM_DOMAIN = original.teamDomain;
    env.ACCESS_AUD = original.aud;
    env.ACCESS_JWKS_JSON = original.jwks;
    vi.restoreAllMocks();
  });

  it("ACCESS_AUD 為空時，即使 JWT 完全合法也拒絕", async () => {
    const jwt = await mintAccessJwt();
    env.ACCESS_AUD = "";
    await expectAllRejected(jwt);
  });

  it("ACCESS_TEAM_DOMAIN 為空時拒絕", async () => {
    const jwt = await mintAccessJwt();
    env.ACCESS_TEAM_DOMAIN = "";
    await expectAllRejected(jwt);
  });

  it("local.invalid 但 ACCESS_JWKS_JSON 內容損毀或缺少時拒絕", async () => {
    const jwt = await mintAccessJwt();
    env.ACCESS_JWKS_JSON = "{not json";
    await expectAllRejected(jwt);
    env.ACCESS_JWKS_JSON = undefined;
    await expectAllRejected(jwt);
  });

  it("真實團隊網域搭配內嵌 JWKS 視為設定錯誤，拒絕", async () => {
    const jwt = await mintAccessJwt({ iss: `https://${REMOTE_TEAM_DOMAIN}` });
    env.ACCESS_TEAM_DOMAIN = REMOTE_TEAM_DOMAIN; // ACCESS_JWKS_JSON 仍有值
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expectAllRejected(jwt);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["夾帶 @ 的網址欺騙", "storefront-test.cloudflareaccess.com@evil.com"],
    ["帶路徑與 fragment", "evil.com/x#"],
    ["不是 cloudflareaccess.com", "storefront-test.example.com"],
    ["帶埠號", "storefront-test.cloudflareaccess.com:8443"],
  ])("不合法的團隊網域（%s）拒絕，且不對外抓取", async (_label, teamDomain) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    env.ACCESS_JWKS_JSON = undefined;
    env.ACCESS_TEAM_DOMAIN = teamDomain;
    await expectAllRejected(await mintAccessJwt({ iss: `https://${teamDomain}` }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("沒有內嵌 JWKS 時抓取 Access certs 端點", () => {
  const original = { teamDomain: env.ACCESS_TEAM_DOMAIN, jwks: env.ACCESS_JWKS_JSON };

  beforeEach(async () => {
    await resetDb();
    setNow(NOW);
    env.ACCESS_JWKS_JSON = undefined;
    env.ACCESS_TEAM_DOMAIN = REMOTE_TEAM_DOMAIN;
  });
  afterEach(() => {
    env.ACCESS_TEAM_DOMAIN = original.teamDomain;
    env.ACCESS_JWKS_JSON = original.jwks;
    vi.restoreAllMocks();
  });

  it("從 https://<team>/cdn-cgi/access/certs 取金鑰驗簽，並快取而不是每次都抓", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(original.jwks));
    const jwt = await mintAccessJwt({ iss: `https://${REMOTE_TEAM_DOMAIN}` });

    expect((await app.listProductsForAdmin(jwt)).ok).toBe(true);
    expect((await app.listProductsForAdmin(jwt)).ok).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(`https://${REMOTE_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  });

  it("團隊網域的大小寫與結尾斜線會先正規化", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(original.jwks));
    env.ACCESS_TEAM_DOMAIN = "Storefront-Test.CloudflareAccess.com/";
    const jwt = await mintAccessJwt({ iss: `https://${REMOTE_TEAM_DOMAIN}` });

    expect((await app.listProductsForAdmin(jwt)).ok).toBe(true);
  });
});
