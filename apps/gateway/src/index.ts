import { cancelPayment, createPayment, getPayment, getRefund, refundPayment } from "./api";
import { getAllowance, issueAllowance } from "./allowances";
import { getInvoice, issueInvoice } from "./invoices";
import { type Clock, systemClock } from "./clock";
import { handleConsole } from "./console";
import { type GatewayConfig, readConfig } from "./config";
import { failure, hasBearerKey } from "./http";
import { showPayPage, submitPayPage } from "./pay-page";

const PAYMENT_ID = "([A-Za-z0-9_]+)";
const route = (method: string, pattern: string) => {
  const regex = new RegExp(`^${pattern}$`);
  return (request: Request, pathname: string) => (request.method === method ? regex.exec(pathname)?.slice(1) : undefined);
};

const routes = {
  createPayment: route("POST", "/v1/payments"),
  getPayment: route("GET", `/v1/payments/${PAYMENT_ID}`),
  cancelPayment: route("POST", `/v1/payments/${PAYMENT_ID}/cancel`),
  refundPayment: route("POST", `/v1/payments/${PAYMENT_ID}/refunds`),
  getRefund: route("GET", `/v1/payments/${PAYMENT_ID}/refunds/([A-Za-z0-9_-]+)`),
  issueInvoice: route("POST", "/v1/invoices"),
  getInvoice: route("GET", "/v1/invoices/([A-Za-z0-9_-]+)"),
  issueAllowance: route("POST", "/v1/invoices/([A-Za-z0-9_-]+)/allowances"),
  getAllowance: route("GET", "/v1/allowances/([A-Za-z0-9_-]+)"),
  showPayPage: route("GET", `/pay/${PAYMENT_ID}`),
  submitPayPage: route("POST", `/pay/${PAYMENT_ID}`),
};

async function handleApi(request: Request, pathname: string, env: Env, clock: Clock, config: GatewayConfig) {
  if (!(await hasBearerKey(request, config.apiKey))) {
    return failure(401, "unauthorized", "缺少或錯誤的 API 金鑰");
  }
  if (routes.createPayment(request, pathname)) return createPayment(request, env, clock);
  const get = routes.getPayment(request, pathname);
  if (get) return getPayment(get[0]!, env, clock);
  const cancel = routes.cancelPayment(request, pathname);
  if (cancel) return cancelPayment(cancel[0]!, env, clock);
  const refund = routes.refundPayment(request, pathname);
  if (refund) return refundPayment(refund[0]!, request, env, clock);
  const lookup = routes.getRefund(request, pathname);
  if (lookup) return getRefund(lookup[0]!, lookup[1]!, env);
  if (routes.issueInvoice(request, pathname)) return issueInvoice(request, env, clock);
  const allowance = routes.issueAllowance(request, pathname);
  if (allowance) return issueAllowance(allowance[0]!, request, env, clock);
  const allowanceLookup = routes.getAllowance(request, pathname);
  if (allowanceLookup) return getAllowance(allowanceLookup[0]!, env);
  const invoice = routes.getInvoice(request, pathname);
  if (invoice) return getInvoice(invoice[0]!, env);
  return undefined;
}

export function createGateway(clock: Clock) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const configResult = readConfig(env);
      if (!configResult.ok) {
        // 只記變數名稱，不記值
        console.error(JSON.stringify({ event: "gateway_config_invalid", missing: configResult.missing }));
        return failure(503, "gateway_misconfigured", "閘道尚未設定完成");
      }
      const { config } = configResult;
      const { pathname } = new URL(request.url);

      if (pathname.startsWith("/v1/")) {
        const response = await handleApi(request, pathname, env, clock, config);
        if (response) return response;
      }
      const show = routes.showPayPage(request, pathname);
      if (show) return showPayPage(show[0]!, env, clock);
      const submit = routes.submitPayPage(request, pathname);
      if (submit) return submitPayPage(request, submit[0]!, env, config.webhookSecret, clock);

      const consoleResponse = await handleConsole(request, pathname, env, config, clock);
      if (consoleResponse) return consoleResponse;

      return failure(404, "not_found", "找不到這個路徑");
    },
  } satisfies ExportedHandler<Env>;
}

export default createGateway(systemClock);
