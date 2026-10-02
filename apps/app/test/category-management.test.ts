import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminService } from "../src/admin/service";
import { systemClock } from "../src/shared/clock";
import { mintAccessJwt, adminDeps } from "./access";
import { assignCategory, createCategory } from "./categories";
import { resetDb } from "./db";
import { fakeBucket, imageVariants, uploadAndList } from "./images";

const app = exports.default;
const access = () => ({ teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, jwksJson: env.ACCESS_JWKS_JSON });
const upload = (id: number, uploadId = crypto.randomUUID()) => ({ id, uploadId, variants: imageVariants() });

async function createProduct(jwt: string, name = "分類測試商品") {
  const created = await app.createProduct(jwt, { name, description: "", priceTwd: 100 });
  if (!created.ok) throw new Error("新增商品失敗");
  return created.data.id;
}

async function setImage(jwt: string, id: number) {
  const result = await app.setCategoryImage(jwt, upload(id));
  if (!result.ok) throw new Error(`上傳分類圖片失敗：${result.reason}`);
  return result.data.image;
}

beforeEach(resetDb);

describe("修改分類", () => {
  it("只改名稱與說明（前後空白去除），代稱與圖片不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt, "living", "客廳", "沙發");
    const image = await setImage(jwt, id);
    expect(await app.updateCategory(jwt, { id, name: " 起居室 ", description: " 沙發與茶几 " })).toEqual({ ok: true, data: { id } });
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({
      ok: true,
      data: [{ id, slug: "living", name: "起居室", description: "沙發與茶几", image }],
    });
  });

  it("帶了代稱也無效：代稱維持原值，原網址仍找得到分類", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt, "living", "客廳", "沙發");
    const product = await createProduct(jwt);
    await assignCategory(jwt, product, id);
    await uploadAndList(jwt, product);
    expect(await app.updateCategory(jwt, { id, slug: "changed", name: "客廳", description: "新說明" })).toEqual({ ok: true, data: { id } });
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ slug: "living", description: "新說明" }] });
    expect(await app.getCategory({ slug: "living" })).toMatchObject({ ok: true, data: { id, slug: "living" } });
    expect(await app.getCategory({ slug: "changed" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("名稱與說明沿用建立時的限制，被拒絕時沒有寫入", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt, "living", "客廳", "沙發");
    expect(await app.updateCategory(jwt, { id, name: "  ", description: "x" })).toMatchObject({ ok: false, reason: "invalid_input", fields: { name: ["名稱不可為空"] } });
    expect(await app.updateCategory(jwt, { id, name: "客廳", description: "第一行\n第二行" })).toMatchObject({ ok: false, reason: "invalid_input", fields: { description: ["說明必須是單行文字"] } });
    expect(await app.updateCategory(jwt, { id, name: "名".repeat(51), description: "x" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.updateCategory(jwt, { id, name: "客廳", description: "說".repeat(101) })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ name: "客廳", description: "沙發" }] });
  });

  it("不存在的分類回 category_not_found", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.updateCategory(jwt, { id: 999999, name: "x", description: "x" })).toEqual({ ok: false, reason: "category_not_found" });
  });
});

describe("分類圖片", () => {
  it("上傳後以內容雜湊為 key 存進 R2，後台清單與前台分類都帶出圖片；沒有圖片時為 null", async () => {
    const jwt = await mintAccessJwt();
    const withImage = await createCategory(jwt, "living", "客廳");
    const without = await createCategory(jwt, "dining", "餐廳");
    for (const id of [withImage, without]) {
      const product = await createProduct(jwt);
      await assignCategory(jwt, product, id);
      await uploadAndList(jwt, product);
    }
    const variants = imageVariants();
    const uploaded = await app.setCategoryImage(jwt, { id: withImage, uploadId: crypto.randomUUID(), variants: [...variants].reverse() });
    if (!uploaded.ok) throw new Error(`上傳失敗：${uploaded.reason}`);
    const { image } = uploaded.data;
    expect(image.variants.map((variant) => variant.width)).toEqual([320, 640, 1280]);
    for (const [index, variant] of image.variants.entries()) {
      expect(variant.key).toMatch(new RegExp(`^categories/${withImage}/${image.id}/[a-f0-9]{64}\\.webp$`));
      const object = await env.PRODUCT_IMAGES.get(variant.key);
      expect(object?.httpMetadata?.contentType).toBe("image/webp");
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(variants[index]!.bytes);
    }
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ id: withImage, image }, { id: without, image: null }] });
    expect(await app.listCategories()).toMatchObject({ ok: true, data: [{ id: withImage, image }, { id: without, image: null }] });
  });

  it("更換圖片：D1 換成新記錄，舊圖的 R2 物件被刪除", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    const { objects, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    const first = await service.setCategoryImage(jwt, upload(id));
    const second = await service.setCategoryImage(jwt, upload(id));
    if (!first.ok || !second.ok) throw new Error("上傳失敗");
    expect(second.data.image.id).not.toBe(first.data.image.id);
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ id, image: second.data.image }] });
    expect([...objects.keys()].sort()).toEqual(second.data.image.variants.map((variant) => variant.key).sort());
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM category_images WHERE category_id = ?").bind(id).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("更換圖片時刪除舊物件失敗，不影響上傳結果", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    const { bucket, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    await service.setCategoryImage(jwt, upload(id));
    bucket.delete.mockRejectedValue(new Error("R2 delete failed"));
    const second = await service.setCategoryImage(jwt, upload(id));
    if (!second.ok) throw new Error(`更換失敗：${second.reason}`);
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ image: second.data.image }] });
  });

  it("D1 寫入失敗：盡力刪掉剛寫入的物件，原本的圖片維持不變", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    const { objects, serviceBucket } = fakeBucket();
    const good = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    const first = await good.setCategoryImage(jwt, upload(id));
    if (!first.ok) throw new Error("上傳失敗");
    const failing = { prepare: (sql: string) => env.DB.prepare(sql), batch: vi.fn(async () => { throw new Error("D1 write failed"); }) } as unknown as D1Database;
    const service = createAdminService(failing, systemClock, access(), adminDeps(serviceBucket));
    expect(await service.setCategoryImage(jwt, upload(id))).toEqual({ ok: false, reason: "image_upload_failed" });
    expect([...objects.keys()].sort()).toEqual(first.data.image.variants.map((variant) => variant.key).sort());
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ image: first.data.image }] });
  });

  it("兩個不同 uploadId 並行換圖：被取代的那一張的 R2 物件最後也會被刪除", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    const { objects, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    const results = await Promise.all([service.setCategoryImage(jwt, upload(id)), service.setCategoryImage(jwt, upload(id))]);
    if (!results.every((result) => result.ok)) throw new Error("上傳失敗");
    const listed = await app.listCategoriesForAdmin(jwt);
    if (!listed.ok) throw new Error("讀取失敗");
    const keys = listed.data[0]!.image!.variants.map((variant) => variant.key);
    expect([...objects.keys()].sort()).toEqual(keys.sort());
  });

  it("D1 已提交但回應遺失：確認提交成功後，被取代的舊圖也會被刪除", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    const { objects, serviceBucket } = fakeBucket();
    const good = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    await good.setCategoryImage(jwt, upload(id));
    const lost = { prepare: (sql: string) => env.DB.prepare(sql), batch: async (statements: D1PreparedStatement[]) => { await env.DB.batch(statements); throw new Error("response lost"); } } as unknown as D1Database;
    const service = createAdminService(lost, systemClock, access(), adminDeps(serviceBucket));
    const replaced = await service.setCategoryImage(jwt, upload(id));
    if (!replaced.ok) throw new Error(`更換失敗：${replaced.reason}`);
    expect([...objects.keys()].sort()).toEqual(replaced.data.image.variants.map((variant) => variant.key).sort());
  });

  it("回應遺失後重試相同 uploadId 回原圖片，不再寫 R2", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    const { bucket, objects, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    const input = upload(id);
    const first = await service.setCategoryImage(jwt, input);
    bucket.put.mockClear();
    expect(await service.setCategoryImage(jwt, input)).toEqual(first);
    expect(bucket.put).not.toHaveBeenCalled();
    expect(objects.size).toBe(3);
    const changed = imageVariants();
    const last = changed[0]!.bytes.length - 1;
    changed[0]!.bytes[last] = changed[0]!.bytes[last]! ^ 1;
    expect(await service.setCategoryImage(jwt, { ...input, variants: changed })).toMatchObject({ ok: false, reason: "invalid_input", fields: { uploadId: expect.any(Array) } });
  });

  it("沒有 R2 bucket 時回 image_upload_failed", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    const service = createAdminService(env.DB, systemClock, access(), adminDeps());
    expect(await service.setCategoryImage(jwt, upload(id))).toEqual({ ok: false, reason: "image_upload_failed" });
  });

  it("不存在的分類回 category_not_found 且不寫 R2；格式不符回 invalid_input", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    const { bucket, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    expect(await service.setCategoryImage(jwt, upload(999999))).toEqual({ ok: false, reason: "category_not_found" });
    const bad = imageVariants();
    bad[0]!.bytes = new Uint8Array(new TextEncoder().encode("not an image"));
    expect(await service.setCategoryImage(jwt, { id, uploadId: crypto.randomUUID(), variants: bad })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await service.setCategoryImage(jwt, { id, uploadId: "invalid", variants: imageVariants() })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(bucket.put).not.toHaveBeenCalled();
  });
});

describe("單一分類（後台）", () => {
  it("回傳分類、圖片與商品數；不存在回 category_not_found；未授權被拒", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt, "living", "客廳", "沙發");
    await createCategory(jwt, "dining", "餐廳");
    const image = await setImage(jwt, id);
    expect(await app.getCategoryForAdmin(jwt, { id })).toEqual({
      ok: true,
      data: { id, slug: "living", name: "客廳", description: "沙發", image, productCount: 0, listedProductCount: 0 },
    });
    expect(await app.getCategoryForAdmin(jwt, { id: 999999 })).toEqual({ ok: false, reason: "category_not_found" });
    expect(await app.getCategoryForAdmin(jwt, { id: "x" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.getCategoryForAdmin("", { id })).toEqual({ ok: false, reason: "unauthorized" });
  });
});

describe("刪除分類", () => {
  it("沒有任何商品的分類可以刪除，圖片的 D1 記錄與 R2 物件一併刪除", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt, "living", "客廳");
    const keep = await createCategory(jwt, "dining", "餐廳");
    const { objects, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    await service.setCategoryImage(jwt, upload(id));
    await service.setCategoryImage(jwt, upload(keep));
    expect(objects.size).toBe(6);
    expect(await service.deleteCategory(jwt, { id })).toEqual({ ok: true, data: { id } });
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ id: keep }] });
    expect(objects.size).toBe(3);
    expect([...objects.keys()].every((key) => key.startsWith(`categories/${keep}/`))).toBe(true);
    const rows = await env.DB.prepare("SELECT category_id FROM category_images").all<{ category_id: number }>();
    expect(rows.results).toEqual([{ category_id: keep }]);
    expect(await app.deleteCategory(jwt, { id })).toEqual({ ok: false, reason: "category_not_found" });
  });

  it("沒有圖片的空分類也可以刪除", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt);
    expect(await app.deleteCategory(jwt, { id })).toEqual({ ok: true, data: { id } });
    expect(await app.listCategoriesForAdmin(jwt)).toEqual({ ok: true, data: [] });
  });

  it("有商品（下架或上架）的分類被拒絕，回 category_not_empty，圖片與分類都保留；商品移走後才能刪除", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt, "living", "客廳");
    const other = await createCategory(jwt, "dining", "餐廳");
    const { objects, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    const image = await service.setCategoryImage(jwt, upload(id));
    if (!image.ok) throw new Error("上傳失敗");
    const product = await createProduct(jwt);
    await assignCategory(jwt, product, id);

    expect(await service.deleteCategory(jwt, { id })).toEqual({ ok: false, reason: "category_not_empty" });
    await uploadAndList(jwt, product);
    expect(await service.deleteCategory(jwt, { id })).toEqual({ ok: false, reason: "category_not_empty" });
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ id, image: image.data.image }, { id: other }] });
    expect(objects.size).toBe(3);

    await assignCategory(jwt, product, other);
    expect(await service.deleteCategory(jwt, { id })).toEqual({ ok: true, data: { id } });
    expect(objects.size).toBe(0);
  });

  it("輸入無效回 invalid_input", async () => {
    const jwt = await mintAccessJwt();
    expect(await app.deleteCategory(jwt, { id: "x" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.deleteCategory(jwt, null)).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

describe("前台依代稱取分類", () => {
  it("帶出分類圖片，形狀與 listCategories 相同；沒有圖片為 null", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt, "living", "客廳");
    const dining = await createCategory(jwt, "dining", "餐廳");
    const image = await setImage(jwt, living);
    for (const [categoryId, name] of [[living, "沙發"], [dining, "餐盤"]] as const) {
      const product = await createProduct(jwt, name);
      await assignCategory(jwt, product, categoryId);
      await uploadAndList(jwt, product);
    }
    expect(await app.getCategory({ slug: "living" })).toMatchObject({ ok: true, data: { id: living, image } });
    expect(await app.getCategory({ slug: "dining" })).toMatchObject({ ok: true, data: { id: dining, image: null } });
  });
});

describe("後台分類清單的商品數", () => {
  it("每個分類帶商品數與上架商品數", async () => {
    const jwt = await mintAccessJwt();
    const living = await createCategory(jwt, "living", "客廳");
    const empty = await createCategory(jwt, "empty", "空分類");
    const mug = await createProduct(jwt, "馬克杯");
    const lamp = await createProduct(jwt, "檯燈");
    const sofa = await createProduct(jwt, "沙發");
    for (const product of [mug, lamp, sofa]) await assignCategory(jwt, product, living);
    await uploadAndList(jwt, mug);
    await uploadAndList(jwt, lamp);
    await app.unlistProduct(jwt, { id: lamp });
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({
      ok: true,
      data: [
        { id: living, productCount: 3, listedProductCount: 1 },
        { id: empty, productCount: 0, listedProductCount: 0 },
      ],
    });
  });
});

describe("未授權", () => {
  it("沒有有效 Access JWT 的修改、上傳、刪除一律被拒絕，且沒有寫入", async () => {
    const jwt = await mintAccessJwt();
    const id = await createCategory(jwt, "living", "客廳", "沙發");
    const { bucket, objects, serviceBucket } = fakeBucket();
    const service = createAdminService(env.DB, systemClock, access(), adminDeps(serviceBucket));
    const unauthorized = { ok: false, reason: "unauthorized" };
    for (const bad of ["", "not-a-jwt"]) {
      expect(await service.updateCategory(bad, { id, name: "被改", description: "被改" })).toEqual(unauthorized);
      expect(await service.setCategoryImage(bad, upload(id))).toEqual(unauthorized);
      expect(await service.deleteCategory(bad, { id })).toEqual(unauthorized);
    }
    expect(bucket.put).not.toHaveBeenCalled();
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
    expect(await app.listCategoriesForAdmin(jwt)).toMatchObject({ ok: true, data: [{ id, name: "客廳", description: "沙發", image: null }] });
  });
});
