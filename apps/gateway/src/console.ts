import { desc, eq, inArray } from "drizzle-orm";
import type { Clock } from "./clock";
import { escapeHtml, htmlResponse } from "./html";
import { failure, safeEqual } from "./http";
import type { GatewayConfig } from "./config";
import { effectiveStatus, findPayment, makeDb, toggleFailNextRefund } from "./payments";
import { deliveries, events, payments, refunds } from "./schema";
import { deliverEvent } from "./webhooks";

const MAX_PAYMENTS = 50;

/** 主控頁用 HTTP Basic：帳號任意，密碼是 GATEWAY_API_KEY；瀏覽器原生就會跳出登入框。 */
async function hasBasicKey(request: Request, apiKey: string): Promise<boolean> {
  const match = /^Basic (.+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  let decoded: string;
  try {
    decoded = atob(match[1]!);
  } catch {
    return false;
  }
  return safeEqual(decoded.slice(decoded.indexOf(":") + 1), apiKey);
}

const challenge = () =>
  new Response("需要認證", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="gateway console", charset="UTF-8"' },
  });

const formatTime = (epochMs: number) => new Date(epochMs).toISOString();

async function renderConsole(env: Env, clock: Clock): Promise<Response> {
  const db = makeDb(env);
  const paymentRows = await db.select().from(payments).orderBy(desc(payments.createdAt)).limit(MAX_PAYMENTS);
  const ids = paymentRows.map((row) => row.id);
  const eventRows = ids.length ? await db.select().from(events).where(inArray(events.paymentId, ids)) : [];
  const deliveryRows = eventRows.length
    ? await db
        .select()
        .from(deliveries)
        .where(
          inArray(
            deliveries.eventId,
            eventRows.map((row) => row.id),
          ),
        )
        .orderBy(deliveries.id)
    : [];

  const refundRows = ids.length ? await db.select().from(refunds).where(inArray(refunds.paymentId, ids)).orderBy(refunds.createdAt) : [];

  const now = clock.now();
  const sections = paymentRows.map((payment) => {
    const eventItems = eventRows
      .filter((event) => event.paymentId === payment.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((event) => {
        const attempts = deliveryRows.filter((delivery) => delivery.eventId === event.id);
        const attemptHtml = attempts.length
          ? attempts
              .map((a) =>
                escapeHtml(`${formatTime(a.attemptedAt)} ${a.statusCode === null ? `失敗：${a.error ?? ""}` : `HTTP ${a.statusCode}`}`),
              )
              .join("<br>")
          : "尚未投遞";
        return `<tr>
<td><code>${escapeHtml(event.id)}</code><br>${escapeHtml(event.type)}</td>
<td>${attemptHtml}</td>
<td><form method="post" action="/console/events/${escapeHtml(event.id)}/send"><button type="submit">${attempts.length ? "重送" : "立即送出"}</button></form></td>
</tr>`;
      })
      .join("\n");
    const refundItems = refundRows
      .filter((refund) => refund.paymentId === payment.id)
      .map((refund) => `<li><code>${escapeHtml(refund.id)}</code> NT$ ${escapeHtml(refund.amountTwd)} ${refund.status === "succeeded" ? "已退回" : "失敗（可用同一個 refundId 重試）"}</li>`)
      .join("\n");
    return `<section>
<h2><code>${escapeHtml(payment.id)}</code> — ${escapeHtml(effectiveStatus(payment, now))}</h2>
<p>訂單參考：${escapeHtml(payment.merchantReference)}，NT$ ${escapeHtml(payment.amountTwd)}，失效時間 ${formatTime(payment.expiresAt)}</p>
<form method="post" action="/console/payments/${escapeHtml(payment.id)}/toggle-refund-failure">下一次退款失敗：${payment.failNextRefund ? "是" : "否"} <button type="submit">切換</button></form>
<p>退款：</p><ul>${refundItems || "<li>尚無退款</li>"}</ul>
<table><thead><tr><th>事件</th><th>投遞紀錄</th><th></th></tr></thead><tbody>${eventItems}</tbody></table>
</section>`;
  });

  return htmlResponse(`<h1>模擬金流閘道主控頁</h1>\n${sections.join("\n") || "<p>還沒有付款。</p>"}`, "主控頁");
}

/** GET /console、POST /console/events/:id/send、POST /console/payments/:id/toggle-refund-failure。 */
export async function handleConsole(
  request: Request,
  pathname: string,
  env: Env,
  config: GatewayConfig,
  clock: Clock,
): Promise<Response | undefined> {
  const send = /^\/console\/events\/([A-Za-z0-9_]+)\/send$/.exec(pathname);
  const toggle = /^\/console\/payments\/([A-Za-z0-9_]+)\/toggle-refund-failure$/.exec(pathname);
  const isList = request.method === "GET" && pathname === "/console";
  if (!isList && !((send || toggle) && request.method === "POST")) return undefined;

  if (!(await hasBasicKey(request, config.apiKey))) return challenge();
  if (isList) return renderConsole(env, clock);

  // 瀏覽器會自動附上快取的 Basic 認證，所以拒絕跨站來源的 POST（非瀏覽器客戶端不帶 Origin）
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return failure(403, "forbidden_origin", "不接受跨站來源的請求");
  }

  const db = makeDb(env);
  if (toggle) {
    const flag = await toggleFailNextRefund(db, toggle[1]!);
    if (flag === undefined) return failure(404, "payment_not_found", "找不到這筆付款");
    return new Response(null, { status: 303, headers: { Location: "/console" } });
  }

  const event = (await db.select().from(events).where(eq(events.id, send![1]!)).limit(1))[0];
  const payment = event && (await findPayment(db, event.paymentId));
  if (!event || !payment) return failure(404, "event_not_found", "找不到這個事件");

  await deliverEvent(db, config.webhookSecret, clock, event, payment.webhookUrl);
  return new Response(null, { status: 303, headers: { Location: "/console" } });
}
