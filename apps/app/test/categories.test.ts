import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateRogueKey, mintAccessJwt } from "./access";
import { assignCategory, createCategory } from "./categories";
import { resetDb } from "./db";
import { uploadAndList } from "./images";

const app = exports.default;
const LIVING = { slug: "living", name: "客廳", description: "沙發、茶几與落地燈" };

describe("建立分類", () => {
  beforeEach(resetDb);

  it("管理員建立分類，後台清單看得到，商品數為 0；沒有上架商品所以前台不列出", async () => {
    const jwt = await mintAccessJwt();
    const created = await app.createCategory(jwt, LIVING);
    expect(created).toEqual({ ok: true, data: { id: expect.any(Number), slug: "living" } });
    expect(await app.listCategoriesForAdmin(jwt)).toEqual({
      ok: true,
      data: [{ id: expect.any(Number), ...LIVING, productCount: 0 }],
    });
    expect(await app.listCategories()).toEqual({ ok: true, data: [] });
  });

  it("名稱與說明前後空白會被去除", async () => {
    const jwt = await mintAccessJwt();
    await app.createCategory(jwt, { slug: "dining", name: "  餐廳 ", description: " 餐桌與餐椅 " });
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ name: "餐廳", description: "餐桌與餐椅" }] });
  });

  it("後台清單依建立順序，商品數含上架與下架的商品", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt, "living", "客廳");
    const dining = await createCategory(jwt, "dining", "餐廳");
    const mug = await app.createProduct(jwt, { name: "馬克杯", description: "", priceTwd: 320 });
    const lamp = await app.createProduct(jwt, { name: "檯燈", description: "", priceTwd: 900 });
    if (!mug.ok || !lamp.ok) throw new Error("新增商品失敗");
    await assignCategory(jwt, mug.data.id, dining);
    await assignCategory(jwt, lamp.data.id, dining);
    await uploadAndList(jwt, mug.data.id);

    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({
      ok: true,
      data: [
        { id: living, slug: "living", productCount: 0 },
        { id: dining, slug: "dining", productCount: 2 },
      ],
    });
  });

  it.each([
    ["大寫", "Living"],
    ["空白", "living room"],
    ["底線", "living_room"],
    ["中文", "客廳"],
    ["開頭連字號", "-living"],
    ["結尾連字號", "living-"],
    ["連續連字號", "living--room"],
    ["空字串", ""],
    ["超過 64 字元", "a".repeat(65)],
  ])("代稱含%s被拒絕，回 invalid_slug 且沒有寫入", async (_label, slug) => {
    const jwt = await mintAccessJwt();
    expect(await app.createCategory(jwt, { ...LIVING, slug })).toEqual({ ok: false, reason: "invalid_slug" });
    expect(await app.listCategoriesForAdmin(jwt)).toEqual({ ok: true, data: [] });
  });

  it.each(["living", "living-room", "a1", "2024-picks", "a".repeat(64)])("合法的代稱 %s 被接受", async (slug) => {
    const jwt = await mintAccessJwt();
    expect(await app.createCategory(jwt, { ...LIVING, slug })).toMatchObject({ ok: true });
  });

  it("代稱重複回 slug_taken，原本的分類不變", async () => {
    const jwt = await mintAccessJwt();
    await createCategory(jwt, "living", "客廳");
    expect(await app.createCategory(jwt, { slug: "living", name: "另一個客廳", description: "x" })).toEqual({ ok: false, reason: "slug_taken" });
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ slug: "living", name: "客廳" }] });
  });

  it("名稱與說明在邊界驗證：空白名稱、空白說明、說明含換行、過長都帶 invalid_input 與欄位錯誤", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.createCategory(jwt, { ...LIVING, name: "   " })).toMatchObject({ ok: false, reason: "invalid_input", fields: { name: ["名稱不可為空"] } });
    expect(await app.createCategory(jwt, { ...LIVING, description: "  " })).toMatchObject({ ok: false, reason: "invalid_input", fields: { description: ["說明不可為空"] } });
    expect(await app.createCategory(jwt, { ...LIVING, description: "第一行\n第二行" })).toMatchObject({ ok: false, reason: "invalid_input", fields: { description: ["說明必須是單行文字"] } });
    expect(await app.createCategory(jwt, { ...LIVING, name: "名".repeat(51) })).toMatchObject({ ok: false, reason: "invalid_input", fields: { name: [expect.any(String)] } });
    expect(await app.createCategory(jwt, { ...LIVING, description: "說".repeat(101) })).toMatchObject({ ok: false, reason: "invalid_input", fields: { description: [expect.any(String)] } });
    expect(await app.createCategory(jwt, { ...LIVING, slug: 42 })).toMatchObject({ ok: false, reason: "invalid_input", fields: { slug: [expect.any(String)] } });
    expect(await app.createCategory(jwt, null)).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.listCategoriesForAdmin(jwt)).toEqual({ ok: true, data: [] });
  });

  it("沒有有效 Access JWT 的建立與列出被拒絕，且沒有寫入", async () => {
    const unauthorized = { ok: false, reason: "unauthorized" };
    expect(await app.createCategory("", LIVING)).toEqual(unauthorized);
    expect(await app.createCategory("not-a-jwt", LIVING)).toEqual(unauthorized);
    expect(await app.createCategory(await mintAccessJwt({ key: await generateRogueKey() }), LIVING)).toEqual(unauthorized);
    expect(await app.listCategoriesForAdmin("")).toEqual(unauthorized);
    expect(await app.listCategoriesForAdmin(await mintAccessJwt())).toEqual({ ok: true, data: [] });
  });
});
