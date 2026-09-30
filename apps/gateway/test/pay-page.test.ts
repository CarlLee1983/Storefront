import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyWebhookSignature } from "../src/webhook-signature";
import { setNow } from "./clock";
import { TEST_WEBHOOK_SECRET } from "./constants";
import { api, captureWebhooks, createPayment, resetDb, RETURN_URL, send, submitPayPage } from "./helpers";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const statusOf = async (paymentId: string) =>
  ((await (await api("GET", `/v1/payments/${paymentId}`)).json()) as { data: { status: string } }).data.status;

describe("付款頁 GET /pay/:id", () => {
  beforeEach(resetDb);

  it("有效的付款顯示金額與三組選項，免認證", async () => {
    const { paymentId } = await createPayment({ amountTwd: 1280 });

    const response = await send(`/pay/${paymentId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("NT$ 1280");
    for (const value of ["success", "failure", "immediate", "delayed"]) expect(html).toContain(`value="${value}"`);
    expect(html).toContain('name="duplicate"');
    expect(html).toContain('name="noRedirect"');
  });

  it("所有頁面帶 CSP，允許表單送出與導回", async () => {
    const { paymentId } = await createPayment();

    const csp = (await send(`/pay/${paymentId}`)).headers.get("Content-Security-Policy");

    expect(csp).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http: https:");
  });

  it("merchantReference 會被跳脫，不能注入 HTML", async () => {
    const { paymentId } = await createPayment({ merchantReference: "<script>alert(1)</script>" });

    const html = await (await send(`/pay/${paymentId}`)).text();

    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("不存在的付款回 404，已失效的付款回 409 而且沒有表單", async () => {
    expect((await send("/pay/pay_missing")).status).toBe(404);

    setNow(NOW);
    const { paymentId } = await createPayment();
    setNow(NOW + 10 * MINUTE);
    const expired = await send(`/pay/${paymentId}`);

    expect(expired.status).toBe(409);
    expect(await expired.text()).not.toContain("<form");
  });
});

describe("付款頁送出結果 POST /pay/:id", () => {
  beforeEach(resetDb);

  it("選成功＋立即回呼：導回 returnUrl（附 paymentId），送出一個簽章正確的 payment.succeeded", async () => {
    setNow(NOW);
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment({ amountTwd: 640, merchantReference: "order-42" });

    const response = await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`${RETURN_URL}?paymentId=${paymentId}`);
    expect(await statusOf(paymentId)).toBe("succeeded");
    expect(webhooks).toHaveLength(1);
    const [webhook] = webhooks;
    expect(webhook!.event).toEqual({
      eventId: expect.stringMatching(/^evt_[0-9a-f]{32}$/),
      type: "payment.succeeded",
      paymentId,
      merchantReference: "order-42",
      amountTwd: 640,
      occurredAt: NOW,
    });
    expect(
      await verifyWebhookSignature({
        secret: TEST_WEBHOOK_SECRET,
        header: webhook!.signature ?? "",
        body: webhook!.body,
        nowMs: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it("returnUrl 原有的 query 會保留", async () => {
    captureWebhooks();
    const { paymentId } = await createPayment({ returnUrl: "https://shop.test/return?order=42" });

    const response = await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });

    expect(response.headers.get("Location")).toBe(`https://shop.test/return?order=42&paymentId=${paymentId}`);
  });

  it("選失敗：付款變 failed，送出 payment.failed", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();

    await submitPayPage(paymentId, { outcome: "failure", timing: "immediate" });

    expect(await statusOf(paymentId)).toBe("failed");
    expect(webhooks.map((w) => w.event.type)).toEqual(["payment.failed"]);
  });

  it("重複回呼：同一個事件送兩次，eventId 相同、本文逐字相同", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();

    await submitPayPage(paymentId, { outcome: "success", timing: "immediate", duplicate: "on" });

    expect(webhooks).toHaveLength(2);
    expect(webhooks[0]!.event.eventId).toBe(webhooks[1]!.event.eventId);
    expect(webhooks[0]!.body).toBe(webhooks[1]!.body);
  });

  it("延遲回呼：付款已是 succeeded、使用者照樣被導回，但這時不送 webhook", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();

    const response = await submitPayPage(paymentId, { outcome: "success", timing: "delayed" });

    expect(response.status).toBe(303);
    expect(await statusOf(paymentId)).toBe("succeeded");
    expect(webhooks).toHaveLength(0);
  });

  it("勾選「不導回」（模擬顧客關閉視窗）：不 303，只顯示可以關閉此頁；付款與 webhook 照常", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();

    const response = await submitPayPage(paymentId, { outcome: "success", timing: "delayed", noRedirect: "on" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toContain("付款已完成，您可以關閉此頁");
    expect(await statusOf(paymentId)).toBe("succeeded");
    expect(webhooks).toHaveLength(0);
  });

  it("body 不是表單（例如 JSON）回 400，付款仍是 pending", async () => {
    const { paymentId } = await createPayment();

    const response = await send(`/pay/${paymentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "success", timing: "immediate" }),
    });

    expect(response.status).toBe(400);
    expect(await statusOf(paymentId)).toBe("pending");
  });

  it("狀態轉換與事件在同一個 batch：寫入失敗時付款維持 pending，沒有半套狀態", async () => {
    const { paymentId } = await createPayment();
    vi.spyOn(env.DB, "batch").mockRejectedValue(new Error("D1 unavailable"));

    await expect(submitPayPage(paymentId, { outcome: "success", timing: "immediate" })).rejects.toThrow();
    vi.restoreAllMocks();

    expect(await statusOf(paymentId)).toBe("pending");
  });

  it("每次付款的事件 ID 都不同", async () => {
    const webhooks = captureWebhooks();
    for (let i = 0; i < 2; i++) {
      const { paymentId } = await createPayment();
      await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });
    }

    expect(webhooks[0]!.event.eventId).not.toBe(webhooks[1]!.event.eventId);
  });

  it("付款過期後送出：回 409，付款維持 expired，不送 webhook", async () => {
    setNow(NOW);
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    setNow(NOW + 10 * MINUTE);

    const response = await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });

    expect(response.status).toBe(409);
    expect(await statusOf(paymentId)).toBe("expired");
    expect(webhooks).toHaveLength(0);
  });

  it("已經有結果的付款不能再送出第二次", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "failure", timing: "immediate" });

    const again = await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });

    expect(again.status).toBe(409);
    expect(await statusOf(paymentId)).toBe("failed");
    expect(webhooks).toHaveLength(1);
  });

  it("選項缺漏或不合法回 400，付款仍是 pending", async () => {
    const { paymentId } = await createPayment();

    expect((await submitPayPage(paymentId, { outcome: "success" })).status).toBe(400);
    expect((await submitPayPage(paymentId, { outcome: "maybe", timing: "immediate" })).status).toBe(400);
    expect(await statusOf(paymentId)).toBe("pending");
  });

  it("不存在的付款回 404", async () => {
    expect((await submitPayPage("pay_missing", { outcome: "success", timing: "immediate" })).status).toBe(404);
  });

  it("呼叫端的 webhook 端點回 500 或連不上，使用者照樣被導回，付款結果照常記錄", async () => {
    captureWebhooks(() => new Response("boom", { status: 500 }));
    const failing = await createPayment();
    expect((await submitPayPage(failing.paymentId, { outcome: "success", timing: "immediate" })).status).toBe(303);

    captureWebhooks(() => {
      throw new TypeError("network down");
    });
    const unreachable = await createPayment();
    expect((await submitPayPage(unreachable.paymentId, { outcome: "success", timing: "immediate" })).status).toBe(303);
    expect(await statusOf(unreachable.paymentId)).toBe("succeeded");
  });
});
