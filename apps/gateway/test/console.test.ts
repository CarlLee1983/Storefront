import { beforeEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/webhook-signature";
import { setNow } from "./clock";
import { TEST_WEBHOOK_SECRET } from "./constants";
import { api, basic, bearer, captureWebhooks, createPayment, ORIGIN, resetDb, send, submitPayPage } from "./helpers";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const openConsole = () => send("/console", { headers: basic() });

/** 從主控頁 HTML 取出第一個事件的 ID。 */
const firstEventId = async () => /evt_[0-9a-f]{32}/.exec(await (await openConsole()).text())![0];

const sendFromConsole = (eventId: string, headers: Record<string, string> = basic()) =>
  send(`/console/events/${eventId}/send`, { method: "POST", headers, redirect: "manual" });

describe("開發主控頁 GET /console", () => {
  beforeEach(resetDb);

  it("沒有認證回 401 並要求 Basic；Bearer、錯誤密碼都不行", async () => {
    const none = await send("/console");
    const wrong = await send("/console", { headers: basic("wrong") });
    const bearerOnly = await send("/console", { headers: bearer() });

    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toMatch(/^Basic /);
    expect(wrong.status).toBe(401);
    expect(bearerOnly.status).toBe(401);
  });

  it("以 API 金鑰做 Basic 密碼：列出付款、狀態與事件", async () => {
    captureWebhooks();
    const { paymentId } = await createPayment({ merchantReference: "order-<b>1" });
    await submitPayPage(paymentId, { outcome: "success", timing: "delayed" });

    const response = await openConsole();

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(paymentId);
    expect(html).toContain("succeeded");
    expect(html).toContain("payment.succeeded");
    expect(html).toContain("order-&lt;b&gt;1");
    expect(html).not.toContain("order-<b>1");
  });

  it("事件顯示尚未投遞、投遞後顯示每次的結果", async () => {
    captureWebhooks(() => new Response("nope", { status: 500 }));
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "delayed" });
    expect(await (await openConsole()).text()).toContain("尚未投遞");

    await sendFromConsole(await firstEventId());

    const html = await (await openConsole()).text();
    expect(html).not.toContain("尚未投遞");
    expect(html).toContain("HTTP 500");
  });
});

describe("主控頁送出 webhook POST /console/events/:id/send", () => {
  beforeEach(resetDb);

  it("延遲回呼的事件可以立即送出，導回主控頁", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "delayed" });
    const eventId = await firstEventId();

    const response = await sendFromConsole(eventId);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/console");
    expect(webhooks.map((w) => w.event)).toEqual([expect.objectContaining({ eventId, type: "payment.succeeded", paymentId })]);
  });

  it("重現遲到的付款成功：付款期限後才送出，本文保留原本的 occurredAt，簽章的 timestamp 是送出當下", async () => {
    setNow(NOW);
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "delayed" });
    const eventId = await firstEventId();

    setNow(NOW + 20 * MINUTE);
    await sendFromConsole(eventId);

    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]!.event.occurredAt).toBe(NOW);
    expect(
      await verifyWebhookSignature({
        secret: TEST_WEBHOOK_SECRET,
        header: webhooks[0]!.signature ?? "",
        body: webhooks[0]!.body,
        nowMs: NOW + 20 * MINUTE,
      }),
    ).toEqual({ ok: true });
    // 付款在期限內就已經 succeeded，遲到的是回呼而不是付款
    const status = (await (await api("GET", `/v1/payments/${paymentId}`)).json()) as { data: { status: string } };
    expect(status.data.status).toBe("succeeded");
  });

  it("重送同一個事件：eventId 與本文不變，投遞紀錄累加", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });
    const eventId = await firstEventId();

    await sendFromConsole(eventId);
    await sendFromConsole(eventId);

    expect(webhooks).toHaveLength(3);
    expect(new Set(webhooks.map((w) => w.event.eventId))).toEqual(new Set([eventId]));
    expect(new Set(webhooks.map((w) => w.body)).size).toBe(1);
  });

  it("投遞不跟隨導向：對方回 302 只記錄 HTTP 302", async () => {
    const webhooks = captureWebhooks(
      () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } }),
    );
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "immediate" });

    expect(webhooks[0]!.redirect).toBe("manual");
    expect(await (await openConsole()).text()).toContain("HTTP 302");
  });

  it("沒有認證回 401 且不送出", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "delayed" });
    const eventId = await firstEventId();

    expect((await sendFromConsole(eventId, {})).status).toBe(401);
    expect(webhooks).toHaveLength(0);
  });

  it("跨站來源（Origin 不是本站）被擋下，避免瀏覽器帶著快取的 Basic 認證被 CSRF", async () => {
    const webhooks = captureWebhooks();
    const { paymentId } = await createPayment();
    await submitPayPage(paymentId, { outcome: "success", timing: "delayed" });
    const eventId = await firstEventId();

    const forged = await sendFromConsole(eventId, { ...basic(), Origin: "https://evil.test" });
    const sameSite = await sendFromConsole(eventId, { ...basic(), Origin: ORIGIN });

    expect(forged.status).toBe(403);
    expect(sameSite.status).toBe(303);
    expect(webhooks).toHaveLength(1);
  });

  it("不存在的事件回 404", async () => {
    expect((await sendFromConsole("evt_missing")).status).toBe(404);
  });
});
