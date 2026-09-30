import type { Clock } from "./clock";
import { escapeHtml, htmlResponse } from "./html";
import { effectiveStatus, findPayment, makeDb } from "./payments";
import { transitionWithEvent } from "./transitions";
import { deliverEvent } from "./webhooks";

const TITLE = "模擬金流閘道";

const notice = (message: string, status: number) =>
  htmlResponse(`<h1>${TITLE}</h1><p>${escapeHtml(message)}</p>`, TITLE, status);

const PAYMENT_NOT_FOUND = () => notice("找不到這筆付款。", 404);
const PAYMENT_CLOSED = (status: string) => notice(`這筆付款已無法操作（目前狀態：${status}）。`, 409);

/** GET /pay/:id：顯示付款資訊與結果選項；只有有效的 pending 付款才有表單。 */
export async function showPayPage(paymentId: string, env: Env, clock: Clock): Promise<Response> {
  const payment = await findPayment(makeDb(env), paymentId);
  if (!payment) return PAYMENT_NOT_FOUND();
  const status = effectiveStatus(payment, clock.now());
  if (status !== "pending") return PAYMENT_CLOSED(status);

  return htmlResponse(
    `<h1>${TITLE}</h1>
<p>訂單參考：<code>${escapeHtml(payment.merchantReference)}</code></p>
<p>金額：NT$ ${escapeHtml(payment.amountTwd)}</p>
<form method="post" action="/pay/${escapeHtml(payment.id)}">
<fieldset><legend>付款結果</legend>
<label><input type="radio" name="outcome" value="success" checked> 成功</label><br>
<label><input type="radio" name="outcome" value="failure"> 失敗</label>
</fieldset>
<fieldset><legend>回呼時機</legend>
<label><input type="radio" name="timing" value="immediate" checked> 立即回呼</label><br>
<label><input type="radio" name="timing" value="delayed"> 延遲回呼（先不送，到 /console 手動送出）</label>
</fieldset>
<label><input type="checkbox" name="duplicate" value="on"> 重複回呼（立即回呼時，同一事件送兩次）</label><br>
<label><input type="checkbox" name="noRedirect" value="on"> 不導回（模擬顧客關閉視窗）</label>
<p><button type="submit">送出</button></p>
</form>`,
    TITLE,
  );
}

/** POST /pay/:id：記錄結果、依選項送出 webhook，最後導向 returnUrl。 */
export async function submitPayPage(
  request: Request,
  paymentId: string,
  env: Env,
  webhookSecret: string,
  clock: Clock,
): Promise<Response> {
  const db = makeDb(env);
  const payment = await findPayment(db, paymentId);
  if (!payment) return PAYMENT_NOT_FOUND();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return notice("請從付款頁送出表單。", 400);
  }
  const outcome = form.get("outcome");
  const timing = form.get("timing");
  if ((outcome !== "success" && outcome !== "failure") || (timing !== "immediate" && timing !== "delayed")) {
    return notice("請選擇付款結果與回呼時機。", 400);
  }

  const now = clock.now();
  const succeeded = outcome === "success";
  const event = await transitionWithEvent(
    db,
    payment,
    {
      from: ["pending"],
      to: succeeded ? "succeeded" : "failed",
      event: succeeded ? "payment.succeeded" : "payment.failed",
      requireUnexpired: true,
    },
    now,
  );
  if (!event) {
    // 讀取與轉換之間狀態可能被取消或逾時改掉，訊息以最新狀態為準
    const latest = (await findPayment(db, payment.id)) ?? payment;
    return PAYMENT_CLOSED(effectiveStatus(latest, now));
  }

  if (timing === "immediate") {
    // 刻意同步投遞（決定論，見 deliverEvent），不要改成 waitUntil
    const deliveries = form.get("duplicate") === "on" ? 2 : 1;
    for (let i = 0; i < deliveries; i++) {
      await deliverEvent(db, webhookSecret, clock, event, payment.webhookUrl);
    }
  }

  if (form.get("noRedirect") === "on") {
    return htmlResponse(`<h1>${TITLE}</h1><p>付款已完成，您可以關閉此頁。</p>`, TITLE);
  }

  const returnUrl = new URL(payment.returnUrl);
  returnUrl.searchParams.set("paymentId", payment.id);
  return new Response(null, { status: 303, headers: { Location: returnUrl.toString() } });
}
