import { z } from "zod";
import { orderIdInput } from "../orders/input";
import { lineQuantities, optionalText, requestKey } from "../shared/case-input";
import { wholeNumber } from "../shared/input";

/** 申請取消的明細：數量不可超過明細「未交運且未被其他申請占用」的數量，由寫入端的條件保證。 */
export const requestCancellationInput = z.object({ orderId: orderIdInput.shape.orderId, requestKey, items: lineQuantities("取消"), reason: optionalText("申請原因") });

export const decideCancellationInput = z.object({
  requestId: wholeNumber("取消申請編號").positive("取消申請編號無效"),
  decision: z.enum(["approve", "reject"], { error: "審核結果無效" }),
  note: optionalText("審核備註"),
});

export type RequestCancellationInput = z.output<typeof requestCancellationInput>;
export type DecideCancellationInput = z.output<typeof decideCancellationInput>;
