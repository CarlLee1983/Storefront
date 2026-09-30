import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { loginUrl } from "../../../auth/customer";
import { parseOrderId } from "../../../orders/labels";
import { parsePaymentReturn, paymentReturnLocation } from "../../../payments/redirects";

export const prerender = false;

// 顧客付完款被閘道導回：向閘道查詢一次（與 webhook 共用冪等的套用動作），然後回訂單頁；
// webhook 可能還沒到，所以這裡一定要查，顧客才會立刻看到已付款
export const GET: APIRoute = async ({ params, url, request, locals, redirect }) => {
  if (!locals.customer) return redirect(loginUrl(url), 303);

  const parsed = parsePaymentReturn(params.id, url.searchParams);
  if (!parsed) {
    const orderId = parseOrderId(params.id);
    return redirect(orderId === null ? "/orders" : `/orders/${orderId}`, 303);
  }
  const result = await env.APP.confirmPayment(request.headers.get("cookie") ?? "", parsed);
  if (!result.ok && result.reason === "unauthorized") return redirect(loginUrl(url), 303);
  return redirect(paymentReturnLocation(parsed.orderId, result), 303);
};
