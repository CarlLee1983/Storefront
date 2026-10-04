import { z } from "zod";
import { wholeNumber } from "../shared/input";
import { shippingInfo } from "../orders/input";

/** 每位顧客地址簿的筆數上限：擋掉亂填，也讓列表不需要分頁。 */
export const MAX_ADDRESSES = 10;

/** 地址簿的一筆收件資訊，欄位規則與結帳的收件資訊相同。 */
export const addAddressInput = shippingInfo;

const addressId = wholeNumber("地址編號").positive("地址編號無效");

export const updateAddressInput = shippingInfo.extend({ addressId });

export const deleteAddressInput = z.object({ addressId });
