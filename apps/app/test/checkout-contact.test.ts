import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { checkoutInput, createStockedListing } from "./checkout-helpers";
import { signInCustomer } from "./customers";
import { resetDb } from "./db";

const app = exports.default;

beforeEach(resetDb);

async function verify(cookie: string, email: string) {
  const requested = await app.requestContactEmail(cookie, { email });
  if (!requested.ok) throw new Error("要求驗證失敗");
  const mail = await app.getMyMail(cookie, { messageId: requested.data.messageId });
  if (!mail.ok || mail.data.verification?.status !== "pending") throw new Error("缺驗證連結");
  await app.verifyContactEmail(cookie, { token: mail.data.verification.token });
}

describe("結帳要求已驗證的聯絡 email", () => {
  it("沒有已驗證聯絡 email 的顧客結帳被拒絕，不成立訂單", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 5);
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });

    expect(await app.checkout(cookie, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toEqual({ ok: false, reason: "contact_email_unverified" });
    expect(await app.listMyOrders(cookie)).toEqual({ ok: true, data: [] });
  });

  it("只送出、尚未驗證新地址仍不能結帳；驗證後可以", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 5);
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await app.requestContactEmail(cookie, { email: "alice@example.com" });
    const lines = [{ variantId, quantity: 1, seenUnitPriceTwd: 320 }];

    expect(await app.checkout(cookie, checkoutInput(lines))).toMatchObject({ ok: false, reason: "contact_email_unverified" });

    await verify(cookie, "alice@example.com");
    expect(await app.checkout(cookie, checkoutInput(lines))).toMatchObject({ ok: true });
  });

  it("換址的新地址尚未驗證時，既有已驗證地址仍讓顧客可以結帳", async () => {
    const { variantId } = await createStockedListing("馬克杯", 320, 5);
    const cookie = await signInCustomer("alice", "Alice", { verifiedContact: false });
    await verify(cookie, "old@example.com");
    await app.requestContactEmail(cookie, { email: "new@example.com" });

    expect(await app.checkout(cookie, checkoutInput([{ variantId, quantity: 1, seenUnitPriceTwd: 320 }]))).toMatchObject({ ok: true });
  });
});
