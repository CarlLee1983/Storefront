import { toNumber, toText } from "../shared/form-values";

/** 運費設定表單 → RPC 輸入；不判斷內容是否合法，由 App 驗證。 */
export function shippingRateFormToInput(form: FormData) {
  return { deliveryType: toText(form.get("deliveryType")), feeTwd: toNumber(form.get("feeTwd")) };
}
