import { z } from "zod";
import { categoryId } from "../categories/input";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES, orderIdInput } from "../orders/input";
import { ORDER_STATUSES } from "../orders/schema";
import { SHIPMENT_EVENT_KINDS } from "../shipments/schema";
import { wholeNumber } from "../shared/input";
import { DELIVERY_TYPES } from "../shipping/types";

// 上限：擋掉明顯的手誤與亂填（超長文字、離譜的價格），不是業務規則
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_PRICE_TWD = 10_000_000;
const MAX_STOCK_DELTA = 1_000_000;

const productId = wholeNumber("商品編號").positive("商品編號無效");
const variantId = wholeNumber("商品變體編號").positive("商品變體編號無效");

const name = z
  .string({ error: "名稱必須是文字" })
  .trim()
  .min(1, "名稱不可為空")
  .max(MAX_NAME_LENGTH, `名稱不可超過 ${MAX_NAME_LENGTH} 個字`);

/** 純文字說明，可以留空。 */
const description = z
  .string({ error: "說明必須是文字" })
  .trim()
  .max(MAX_DESCRIPTION_LENGTH, `說明不可超過 ${MAX_DESCRIPTION_LENGTH} 個字`);

/** 尺寸、材質、保養資訊：純文字，可以留空（清空）；更新時不帶表示不動。瀏覽器表單以 \r\n 換行，先正規化成 \n 再計長度。 */
const productInfoText = (label: string) => z
  .string({ error: `${label}必須是文字` })
  .transform((value) => value.replace(/\r\n/g, "\n"))
  .pipe(z.string().trim().max(MAX_DESCRIPTION_LENGTH, `${label}不可超過 ${MAX_DESCRIPTION_LENGTH} 個字`));

/** 單價：新台幣整數元，正整數。 */
const priceTwd = wholeNumber("單價")
  .positive("單價必須大於 0")
  .max(MAX_PRICE_TWD, `單價不可超過 ${MAX_PRICE_TWD}`);

/** 原價：同樣是新台幣整數元的正整數；是否高於售價由 service 以儲存後的結果檢查。 */
const compareAtPriceTwd = wholeNumber("原價")
  .positive("原價必須大於 0")
  .max(MAX_PRICE_TWD, `原價不可超過 ${MAX_PRICE_TWD}`);

/** 低庫存門檻：可售數量降到這個數量以下（含）就提醒；0 表示賣完才提醒，上限只擋手誤。 */
const lowStockThreshold = wholeNumber("低庫存門檻")
  .min(0, "低庫存門檻不可為負")
  .max(MAX_STOCK_DELTA, `低庫存門檻不可超過 ${MAX_STOCK_DELTA}`);

const MAX_OPTION_NAME_LENGTH = 30;
const MAX_OPTION_VALUE_LENGTH = 50;

/** 選項維度名稱（例如「顏色」）；維度最多兩個，名稱不可重複。 */
const optionName = z
  .string({ error: "選項名稱必須是文字" })
  .trim()
  .min(1, "選項名稱不可為空")
  .max(MAX_OPTION_NAME_LENGTH, `選項名稱不可超過 ${MAX_OPTION_NAME_LENGTH} 個字`);

const optionNames = z
  .array(optionName, { error: "選項名稱必須是清單" })
  .max(2, "每個商品最多兩個選項維度")
  .refine((names) => new Set(names).size === names.length, "選項名稱不可重複");

/** 選項值（例如「胡桃色」）；個數必須等於商品的選項維度個數，由 service 以儲存後的結果檢查。 */
const optionValue = z
  .string({ error: "選項值必須是文字" })
  .trim()
  .min(1, "選項值不可為空")
  // 「 / 」是訂單明細選項快照與購物車標籤的分隔符
  .refine((value) => !value.includes(" / "), "選項值不可包含「 / 」")
  .max(MAX_OPTION_VALUE_LENGTH, `選項值不可超過 ${MAX_OPTION_VALUE_LENGTH} 個字`);

const optionValues = z.array(optionValue, { error: "選項值必須是清單" }).max(2, "每個商品最多兩個選項維度");

const deliveryType = z.enum(DELIVERY_TYPES, { error: "配送類型無效" });

/** 新增商品：預設變體的配送類型不帶為一般宅配。 */
export const createProductInput = z.object({ name, description, priceTwd, deliveryType: deliveryType.optional() });

/**
 * 修改商品；`categoryId` 不帶表示不動分類，帶 `null` 表示清成沒有分類
 *（上架中的商品不允許，由 service 檢查）。`compareAtPriceTwd` 不帶表示不動原價，帶 `null` 表示清空（結束特價）。
 * `dimensions`、`material`、`care` 不帶表示不動，帶空字串表示清空。`deliveryType` 是預設變體的配送類型，不帶表示不動。
 */
export const updateProductInput = z.object({
  id: productId,
  name,
  description,
  priceTwd,
  compareAtPriceTwd: compareAtPriceTwd.nullable().optional(),
  categoryId: categoryId.nullable().optional(),
  deliveryType: deliveryType.optional(),
  dimensions: productInfoText("尺寸").optional(),
  material: productInfoText("材質").optional(),
  care: productInfoText("保養").optional(),
});
export const productIdInput = z.object({ id: productId });
export const setProductFeaturedInput = z.object({ id: productId, featured: z.boolean({ error: "精選必須是布林值" }) });

/** 庫存調整的增減量（作用在變體上）：非零整數（+20 補貨、-3 盤損）；沒有「設成某個數字」的輸入。 */
const stockDelta = wholeNumber("增減量")
  .refine((value) => value !== 0, "增減量不可為 0")
  .min(-MAX_STOCK_DELTA, `增減量不可小於 -${MAX_STOCK_DELTA}`)
  .max(MAX_STOCK_DELTA, `增減量不可超過 ${MAX_STOCK_DELTA}`);

const MAX_STOCK_REASON_LENGTH = 200;

/** 庫存調整的原因（補貨、盤損…）：必填，trim 後不可為空；寫進庫存流水供稽核。 */
const stockReason = z
  .string({ error: "原因必須是文字" })
  .trim()
  .min(1, "請填寫調整原因")
  .max(MAX_STOCK_REASON_LENGTH, `原因不可超過 ${MAX_STOCK_REASON_LENGTH} 個字`);

export const adjustStockInput = z.object({ variantId, delta: stockDelta, reason: stockReason });

/** 報廢損壞退貨：數量為正整數，不能超過已檢查確認的損壞品數量（由寫入端條件保證）；原因必填，寫進庫存流水供稽核。 */
export const scrapUnavailableInput = z.object({
  variantId,
  quantity: wholeNumber("報廢數量").min(1, "報廢數量必須是 1 以上的整數").max(MAX_STOCK_DELTA, `報廢數量不可超過 ${MAX_STOCK_DELTA}`),
  reason: stockReason,
});

const MAX_MOVEMENTS_PAGE = 200;

/** 庫存流水查詢：可依變體或訂單篩選，以游標（上一頁最後一筆的編號）分頁，一頁預設 50 筆。 */
export const listStockMovementsInput = z.object({
  variantId: variantId.optional(),
  orderId: orderIdInput.shape.orderId.optional(),
  beforeId: wholeNumber("游標").min(1, "游標無效").optional(),
  limit: wholeNumber("每頁筆數").min(1, "每頁至少 1 筆").max(MAX_MOVEMENTS_PAGE, `每頁不可超過 ${MAX_MOVEMENTS_PAGE} 筆`).default(50),
});

const MAX_TRACKING_NUMBER_LENGTH = 100;

/** 物流單號：選填；trim 後是空字串就視為沒有（存 null）。 */
const trackingNumber = z
  .string({ error: "物流單號必須是文字" })
  .trim()
  .max(MAX_TRACKING_NUMBER_LENGTH, `物流單號不可超過 ${MAX_TRACKING_NUMBER_LENGTH} 個字`)
  // 只收可列印 ASCII（含空格）：擋掉換行與控制字元，物流單號本來就只有英數與符號
  .regex(/^[\x20-\x7E]*$/, "物流單號只能包含英數字與一般符號")
  .transform((value) => (value === "" ? null : value))
  .optional()
  .transform((value) => value ?? null);

const MAX_DISPATCH_KEY_LENGTH = 64;

/** 一次提交的冪等鍵：管理員表單渲染時產生一個，重送同一次提交帶同一個，不會重複建立批次。 */
const dispatchKey = z
  .string({ error: "提交識別碼必須是文字" })
  .regex(/^[A-Za-z0-9_-]+$/, "提交識別碼只能包含英數字、底線與連字號")
  .max(MAX_DISPATCH_KEY_LENGTH, `提交識別碼不可超過 ${MAX_DISPATCH_KEY_LENGTH} 個字`);

/** 本批交運的一筆明細：數量不可超過明細的未交運數量，由寫入端的條件保證。 */
const dispatchItem = z.object({
  orderLineId: wholeNumber("訂單明細編號").positive("訂單明細編號無效"),
  quantity: wholeNumber("數量").min(1, "數量必須是 1 以上的整數").max(MAX_LINE_QUANTITY, `數量不可超過 ${MAX_LINE_QUANTITY}`),
});

const dispatchItems = z
  .array(dispatchItem, { error: "交運明細必須是清單" })
  .min(1, "至少要交運一筆明細")
  .max(MAX_ORDER_LINES, `交運明細不可超過 ${MAX_ORDER_LINES} 筆`)
  .refine((items) => new Set(items.map((item) => item.orderLineId)).size === items.length, "同一筆訂單明細不可重複出現");

/** 大型配送議定的時段（UTC epoch 毫秒，起訖成對且訖在起之後）；只含一般宅配的批次不帶。 */
const appointment = z
  .object({
    start: wholeNumber("預約開始時間").positive("預約開始時間無效"),
    end: wholeNumber("預約結束時間").positive("預約結束時間無效"),
  })
  .refine(({ start, end }) => end > start, { message: "預約結束時間必須晚於開始時間", path: ["end"] })
  .nullish()
  .transform((value) => value ?? null);

export const shipOrderInput = z.object({ orderId: orderIdInput.shape.orderId, dispatchKey, items: dispatchItems, trackingNumber, appointment });

/** 物流給的事件識別，限制同一次提交的冪等鍵一樣的字元與長度。 */
const shipmentEventKey = z
  .string({ error: "回報識別碼必須是文字" })
  .regex(/^[A-Za-z0-9_-]+$/, "回報識別碼只能包含英數字、底線與連字號")
  .max(MAX_DISPATCH_KEY_LENGTH, `回報識別碼不可超過 ${MAX_DISPATCH_KEY_LENGTH} 個字`);

/** 記錄一筆物流回報；發生時間須在交運之後、現在之前，由寫入端的條件保證。 */
export const recordShipmentEventInput = z.object({
  shipmentId: wholeNumber("批次編號").positive("批次編號無效"),
  eventKey: shipmentEventKey,
  kind: z.enum(SHIPMENT_EVENT_KINDS, { error: "回報種類無效" }),
  occurredAt: wholeNumber("回報發生時間").positive("回報發生時間無效"),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EMAIL_QUERY_LENGTH = 254;
const MAX_NOTE_LENGTH = 1000;

/** 台北時間的日期（`YYYY-MM-DD`）→ 當天 00:00（UTC epoch 毫秒）；不是真實存在的日期就無效。 */
const taipeiDay = (label: string) => z
  .string({ error: `${label}必須是日期` })
  .regex(/^\d{4}-\d{2}-\d{2}$/, `${label}格式必須是 YYYY-MM-DD`)
  .transform((value, ctx) => {
    const start = Date.parse(`${value}T00:00:00+08:00`);
    if (Number.isNaN(start) || new Date(start + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: "custom", message: `${label}不是有效的日期` });
      return z.NEVER;
    }
    return start;
  });

/**
 * 查找訂單的條件，列表與匯出共用同一份，才保證兩邊範圍一致：編號、顧客 email 片段（不分大小寫）、狀態、成立日期區間（台北時間，含起訖兩天）。
 * 轉成 `from`（含）與 `to`（不含，起訖日當天結束後的零點）兩個 UTC epoch 毫秒。
 */
export const orderFilterFields = {
  orderId: wholeNumber("訂單編號").positive("訂單編號無效").optional(),
  email: z.string({ error: "顧客 email 必須是文字" }).trim().max(MAX_EMAIL_QUERY_LENGTH, `顧客 email 不可超過 ${MAX_EMAIL_QUERY_LENGTH} 個字`).optional(),
  status: z.enum(ORDER_STATUSES, { error: "訂單狀態無效" }).optional(),
  from: taipeiDay("起始日期").optional(),
  to: taipeiDay("結束日期").optional().transform(end => end === undefined ? undefined : end + DAY_MS),
};

/** 列表與匯出：條件加上游標（上一批最後一筆的訂單編號，沒給為第一批）。 */
export const listOrdersInput = z.object({ ...orderFilterFields, beforeId: wholeNumber("游標").positive("游標無效").optional() })
  .refine(({ from, to }) => from === undefined || to === undefined || from < to, { message: "起始日期不可晚於結束日期", path: ["from"] });

/** 客服備註：訂單編號與內容（去頭尾空白後不可為空）。 */
export const addOrderNoteInput = z.object({
  orderId: wholeNumber("訂單編號").positive("訂單編號無效"),
  // 瀏覽器表單以 \r\n 換行，先正規化成 \n 再 trim 與計長度（同商品資訊文字）
  note: z.string({ error: "備註必須是文字" })
    .transform((value) => value.replace(/\r\n/g, "\n"))
    .pipe(z.string().trim().min(1, "備註不可為空").max(MAX_NOTE_LENGTH, `備註不可超過 ${MAX_NOTE_LENGTH} 個字`)),
});

/**
 * 設定商品的選項維度名稱。維度個數不變時只改名稱；要增減個數（含從沒有選項開始）時商品只能有一個變體（預設變體），
 * 並以 `defaultVariantValues` 重設它的選項值。
 */
export const setProductOptionsInput = z.object({ id: productId, optionNames, defaultVariantValues: optionValues.optional() });

/** 新增變體：選項值依商品的維度順序；新變體的在庫數為 0，由庫存調整補貨。 */
export const createVariantInput = z.object({ productId, optionValues, priceTwd, compareAtPriceTwd: compareAtPriceTwd.optional(), deliveryType: deliveryType.optional(), lowStockThreshold: lowStockThreshold.optional() });

/**
 * 修改變體：選項值、售價整組送出；`compareAtPriceTwd` 不帶表示不動原價、`null` 表示清空；
 * `imageId` 不帶表示不動、`null` 表示不指定圖片；`deliveryType` 不帶表示不動；`lowStockThreshold` 不帶表示不動、`null` 表示不提醒。
 */
export const updateVariantInput = z.object({
  variantId,
  optionValues,
  priceTwd,
  compareAtPriceTwd: compareAtPriceTwd.nullable().optional(),
  imageId: z.string({ error: "圖片編號必須是文字" }).min(1, "圖片編號無效").nullable().optional(),
  deliveryType: deliveryType.optional(),
  lowStockThreshold: lowStockThreshold.nullable().optional(),
});

/** 費率上限只擋手誤；0 表示該類型免運。 */
const MAX_SHIPPING_FEE_TWD = 100_000;

/** 調整某配送類型的費率（新台幣整數元）；只影響之後成立的訂單。 */
export const setShippingRateInput = z.object({
  deliveryType,
  feeTwd: wholeNumber("運費").min(0, "運費不可為負").max(MAX_SHIPPING_FEE_TWD, `運費不可超過 ${MAX_SHIPPING_FEE_TWD}`),
});

/** 只設定低庫存門檻：`null` 表示不提醒。 */
export const setLowStockThresholdInput = z.object({ variantId, lowStockThreshold: lowStockThreshold.nullable() });

export const setVariantDiscontinuedInput = z.object({ variantId, discontinued: z.boolean({ error: "停賣必須是布林值" }) });
