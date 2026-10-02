import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { mintAccessJwt } from "./access";
import { assignDefaultCategory } from "./categories";
import { resetDb } from "./db";
import { uploadAndList } from "./images";

const app = exports.default;
beforeEach(resetDb);

async function createListed(jwt: string) {
  const created = await app.createProduct(jwt, { name: "胡桃木邊桌", description: "簡約邊桌", priceTwd: 4800 });
  if (!created.ok) throw new Error("新增商品失敗");
  await uploadAndList(jwt, created.data.id);
  return created.data.id;
}

describe("商品的尺寸、材質與保養資訊", () => {
  it("新商品三項資訊為空字串", async () => {
    const jwt = await mintAccessJwt();
    const id = await createListed(jwt);
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: { dimensions: "", material: "", care: "" } });
  });

  it("管理員維護後，前台詳情頁與後台都看到內容", async () => {
    const jwt = await mintAccessJwt();
    const id = await createListed(jwt);
    await assignDefaultCategory(jwt, id);
    await app.relistProduct(jwt, { id });
    const info = { dimensions: "寬 45 × 深 45 × 高 55 cm", material: "北美胡桃木實木", care: "以乾布擦拭，避免日曬。" };

    expect(await app.updateProduct(jwt, { id, name: "胡桃木邊桌", description: "簡約邊桌", priceTwd: 4800, ...info })).toEqual({ ok: true, data: { id } });

    expect(await app.getProduct({ id })).toMatchObject({ ok: true, data: info });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ ok: true, data: info });
  });

  it("更新時不帶三項資訊表示不動；帶空字串表示清空", async () => {
    const jwt = await mintAccessJwt();
    const id = await createListed(jwt);
    const base = { id, name: "胡桃木邊桌", description: "簡約邊桌", priceTwd: 4800 };
    await app.updateProduct(jwt, { ...base, dimensions: "45 cm", material: "胡桃木", care: "乾布擦拭" });

    await app.updateProduct(jwt, { ...base, name: "胡桃木邊桌 II" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ data: { name: "胡桃木邊桌 II", dimensions: "45 cm", material: "胡桃木", care: "乾布擦拭" } });

    await app.updateProduct(jwt, { ...base, material: "" });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ data: { dimensions: "45 cm", material: "", care: "乾布擦拭" } });
  });

  it("換行以 \\n 計長度：含 \\r\\n 換行恰 2000 字可儲存，並以 \\n 保存", async () => {
    const jwt = await mintAccessJwt();
    const id = await createListed(jwt);
    const base = { id, name: "x", description: "", priceTwd: 1 };
    const care = `${"保".repeat(999)}\n${"養".repeat(1000)}`;

    expect(await app.updateProduct(jwt, { ...base, care: care.replace("\n", "\r\n") })).toEqual({ ok: true, data: { id } });
    expect(await app.getProductForAdmin(jwt, { id })).toMatchObject({ data: { care } });
    expect(await app.updateProduct(jwt, { ...base, care: `${care}x`.replace("\n", "\r\n") })).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("超過長度上限回 invalid_input，且需要管理員身分", async () => {
    const jwt = await mintAccessJwt();
    const id = await createListed(jwt);
    const base = { id, name: "x", description: "", priceTwd: 1 };
    expect(await app.updateProduct(jwt, { ...base, care: "長".repeat(2001) })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await app.updateProduct("not-a-jwt", { ...base, care: "x" })).toMatchObject({ ok: false, reason: "unauthorized" });
  });
});
