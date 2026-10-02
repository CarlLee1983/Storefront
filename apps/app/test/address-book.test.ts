import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { checkoutInput, createStockedVariant } from "./checkout-helpers";
import { setNow } from "./clock";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";

const app = exports.default;
const HOME = { name: "王小明", phone: "0912345678", address: "台北市中正區重慶南路一段 122 號" };
const OFFICE = { name: "王小明", phone: "02-1234-5678", address: "新北市板橋區文化路一段 1 號" };

beforeEach(async () => {
  await resetDb();
  setNow(Date.UTC(2026, 9, 3, 2, 0, 0));
});

async function addOk(cookie: string, input: unknown = HOME) {
  const added = await app.addAddress(cookie, input);
  if (!added.ok) throw new Error(`新增地址失敗：${added.reason}`);
  return added.data;
}

describe("地址簿", () => {
  it("新增後在自己的列表依建立順序出現，欄位去空白", async () => {
    const cookie = await signInCustomer("alice");
    expect(await app.listMyAddresses(cookie)).toEqual({ ok: true, data: [] });

    const first = await addOk(cookie, { name: "  王小明 ", phone: " 0912345678", address: HOME.address });
    const second = await addOk(cookie, OFFICE);

    expect(first).toEqual({ id: expect.any(Number), ...HOME });
    expect(await app.listMyAddresses(cookie)).toEqual({ ok: true, data: [first, second] });
  });

  it("輸入無效時回 invalid_input 並指出欄位", async () => {
    const cookie = await signInCustomer("alice");
    const result = await app.addAddress(cookie, { name: "", phone: "0912345678", address: "x".repeat(301) });
    expect(result).toMatchObject({ ok: false, reason: "invalid_input", fields: { name: [expect.any(String)], address: [expect.any(String)] } });
    expect(await app.listMyAddresses(cookie)).toEqual({ ok: true, data: [] });
  });

  it("修改與刪除自己的地址", async () => {
    const cookie = await signInCustomer("alice");
    const home = await addOk(cookie);
    const office = await addOk(cookie, OFFICE);

    expect(await app.updateAddress(cookie, { addressId: home.id, ...OFFICE, name: "王大明" })).toEqual({ ok: true, data: { id: home.id, ...OFFICE, name: "王大明" } });
    expect(await app.deleteAddress(cookie, { addressId: office.id })).toEqual({ ok: true, data: { addressId: office.id } });
    expect(await app.listMyAddresses(cookie)).toEqual({ ok: true, data: [{ id: home.id, ...OFFICE, name: "王大明" }] });
    expect(await app.deleteAddress(cookie, { addressId: office.id })).toEqual({ ok: false, reason: "address_not_found" });
  });

  it("筆數達上限後拒絕新增，刪除後可再新增", async () => {
    const cookie = await signInCustomer("alice");
    const created = [];
    for (let i = 0; i < 10; i++) created.push(await addOk(cookie, { ...HOME, address: `${HOME.address} ${i}` }));

    expect(await app.addAddress(cookie, HOME)).toEqual({ ok: false, reason: "address_limit_reached" });
    await app.deleteAddress(cookie, { addressId: created[0]!.id });
    expect(await app.addAddress(cookie, HOME)).toMatchObject({ ok: true });
  });

  it("未登入或 session 無效不能使用任何地址簿 RPC", async () => {
    const unauthorized = { ok: false, reason: "unauthorized" };
    for (const cookie of ["", "better-auth.session_token=forged"]) {
      expect(await app.listMyAddresses(cookie)).toEqual(unauthorized);
      expect(await app.addAddress(cookie, HOME)).toEqual(unauthorized);
      expect(await app.updateAddress(cookie, { addressId: 1, ...HOME })).toEqual(unauthorized);
      expect(await app.deleteAddress(cookie, { addressId: 1 })).toEqual(unauthorized);
    }
  });

  it("換成別人的地址編號既讀不到也改不到、刪不掉，結果與不存在的編號相同", async () => {
    const alice = await signInCustomer("alice");
    const bob = await signInCustomer("bob");
    const aliceHome = await addOk(alice);

    expect(await app.listMyAddresses(bob)).toEqual({ ok: true, data: [] });
    expect(await app.updateAddress(bob, { addressId: aliceHome.id, ...OFFICE })).toEqual({ ok: false, reason: "address_not_found" });
    expect(await app.deleteAddress(bob, { addressId: aliceHome.id })).toEqual({ ok: false, reason: "address_not_found" });
    expect(await app.updateAddress(bob, { addressId: aliceHome.id + 999, ...OFFICE })).toEqual({ ok: false, reason: "address_not_found" });
    expect(await app.listMyAddresses(alice)).toEqual({ ok: true, data: [aliceHome] });
  });

  it("訂單的收件資訊是結帳當下的快照：之後修改或刪除地址簿不改歷史訂單", async () => {
    const cookie = await signInCustomer("alice");
    const variantId = await createStockedVariant("花器", 500, 5);
    const home = await addOk(cookie);

    // 結帳時使用地址簿的內容
    const placed = await app.checkout(cookie, { ...checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 500 }]), shippingInfo: { name: home.name, phone: home.phone, address: home.address } });
    if (!placed.ok) throw new Error(`結帳失敗：${placed.reason}`);

    await app.updateAddress(cookie, { addressId: home.id, ...OFFICE });
    expect(await app.getMyOrder(cookie, { orderId: placed.data.orderId })).toMatchObject({ ok: true, data: { shippingInfo: HOME } });

    await app.deleteAddress(cookie, { addressId: home.id });
    expect(await app.getMyOrder(cookie, { orderId: placed.data.orderId })).toMatchObject({ ok: true, data: { shippingInfo: HOME } });
  });
});
