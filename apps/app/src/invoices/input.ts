import { z } from "zod";

export const invoiceIdInput = z.object({
  invoiceId: z.number({ error: "發票編號必須是數字" }).int("發票編號必須是整數").positive("發票編號無效"),
});

export const refundIdInput = z.object({
  refundId: z.number({ error: "退款編號必須是數字" }).int("退款編號必須是整數").positive("退款編號無效"),
});
