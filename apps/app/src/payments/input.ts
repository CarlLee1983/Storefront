import { z } from "zod";
import { GATEWAY_ID_PATTERN, PAYMENT_OUTCOMES } from "./shared";

const gatewayId = (label: string) => z.string({ error: `${label}必須是文字` }).regex(GATEWAY_ID_PATTERN, `${label}格式無效`);

export const confirmPaymentInput = z.object({
  orderId: z.number({ error: "訂單編號必須是數字" }).int("訂單編號必須是整數").positive("訂單編號無效"),
  gatewayPaymentId: gatewayId("閘道付款 ID"),
});

export const applyPaymentResultInput = z.object({
  eventId: gatewayId("事件 ID"),
  gatewayPaymentId: gatewayId("閘道付款 ID"),
  outcome: z.enum(PAYMENT_OUTCOMES, { error: "付款結果必須是 succeeded 或 failed" }),
});

export const reconcilePaymentInput = z.object({
  paymentId: z.number({ error: "付款編號必須是數字" }).int("付款編號必須是整數").positive("付款編號無效"),
});
