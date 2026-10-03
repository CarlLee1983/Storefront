import { z } from "zod";
import { lineQuantities, optionalText, requestKey } from "../shared/case-input";
import { wholeNumber } from "../shared/input";

/** 管理員確認某一批的部分商品遺失：`lossKey` 是表單一次提交的冪等鍵；數量能不能遺失（未送達、未被退貨占用、不超過該批）由寫入端的條件保證。 */
export const confirmShipmentLossInput = z.object({
  shipmentId: wholeNumber("批次編號").positive("批次編號無效"),
  lossKey: requestKey,
  items: lineQuantities("遺失"),
  note: optionalText("備註"),
});

export type ConfirmShipmentLossInput = z.output<typeof confirmShipmentLossInput>;
