import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateRogueKey, mintAccessJwt } from "./access";
import { resetDb } from "./db";

const app = exports.default;

describe("上架商品，前台看得到", () => {
  beforeEach(resetDb);

  it("管理員新增商品後預設下架，不出現在前台清單", async () => {
    const jwt = await mintAccessJwt();
    const created = await app.createProduct(jwt, {
      name: "馬克杯",
      description: "350ml 陶瓷杯",
      priceTwd: 320,
    });
    expect(created.ok).toBe(true);
    expect(await app.listProductsForAdmin(jwt)).toMatchObject({ ok: true, data: [{ listed: false }] });

    const listed = await app.listProducts();
    expect(listed).toEqual({
      ok: true,
      data: { items: [], total: 0, hasMore: false },
    });
  });

  it("沒有 Access JWT 的新增被拒絕，且沒有寫入", async () => {
    const result = await app.createProduct("", { name: "馬克杯", description: "", priceTwd: 320 });
    expect(result).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.listProducts()).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
  });

  it("簽章無效的 Access JWT 被拒絕，且沒有寫入", async () => {
    const jwt = await mintAccessJwt({ key: await generateRogueKey() });
    const result = await app.createProduct(jwt, { name: "馬克杯", description: "", priceTwd: 320 });
    expect(result).toEqual({ ok: false, reason: "unauthorized" });
    expect(await app.listProducts()).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
  });

  it("空白名稱被拒絕，帶 invalid_input 與欄位錯誤，且沒有寫入", async () => {
    const jwt = await mintAccessJwt();
    const result = await app.createProduct(jwt, { name: "   ", description: "", priceTwd: 320 });
    expect(result).toEqual({ ok: false, reason: "invalid_input", fields: { name: ["名稱不可為空"] } });
    expect(await app.listProducts()).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
  });

  it.each([
    ["零", 0],
    ["負數", -50],
    ["小數", 99.5],
    ["字串", "320"],
    ["NaN", Number.NaN],
  ])("單價為%s被拒絕，帶 invalid_input 與 priceTwd 欄位錯誤", async (_label, priceTwd) => {
    const jwt = await mintAccessJwt();
    const result = await app.createProduct(jwt, { name: "馬克杯", description: "", priceTwd });
    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { priceTwd: [expect.any(String)] } });
    expect(await app.listProducts()).toEqual({ ok: true, data: { items: [], total: 0, hasMore: false } });
  });

  it("後台清單需要有效 Access JWT，並列出所有商品", async () => {
    expect(await app.listProductsForAdmin("")).toEqual({ ok: false, reason: "unauthorized" });

    const jwt = await mintAccessJwt();
    await app.createProduct(jwt, { name: "馬克杯", description: "", priceTwd: 320 });
    const listed = await app.listProductsForAdmin(jwt);
    expect(listed).toEqual({
      ok: true,
      data: [expect.objectContaining({ name: "馬克杯", priceTwd: 320, listed: false })],
    });
  });

  it("App Worker 沒有 HTTP 入口，fetch 一律 404", async () => {
    const response = await app.fetch(new Request("https://app.internal/admin"));
    expect(response.status).toBe(404);
  });
});
