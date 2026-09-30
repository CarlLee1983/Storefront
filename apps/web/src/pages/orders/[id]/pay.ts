import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { loginUrl } from "../../../auth/customer";
import { parseOrderId } from "../../../orders/labels";
import { startPaymentLocation } from "../../../payments/redirects";

export const prerender = false;

// 訂單頁的「前往付款」按鈕：發起付款，成功就 303 到閘道的付款頁
export const POST: APIRoute = async ({ params, url, request, locals, redirect }) => {
  if (!locals.customer) return redirect(loginUrl(url), 303);
  const orderId = parseOrderId(params.id);
  if (orderId === null) return redirect("/orders", 303);

  const result = await env.APP.startPayment(request.headers.get("cookie") ?? "", { orderId });
  if (!result.ok && result.reason === "unauthorized") return redirect(loginUrl(url), 303);
  return redirect(startPaymentLocation(orderId, result), 303);
};
