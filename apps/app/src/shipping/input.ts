import { z } from "zod";
import { wholeNumber } from "../shared/input";
import { MAX_ORDER_LINES } from "../orders/input";

/** 結帳畫面試算運費：購物車裡的變體編號，上限與一張訂單的明細筆數一致。 */
export const shippingQuoteInput = z.object({
  variantIds: z.array(wholeNumber("商品變體編號").positive("商品變體編號無效"), { error: "商品變體編號必須是清單" })
    .max(MAX_ORDER_LINES, `一次最多 ${MAX_ORDER_LINES} 個商品變體`),
});
