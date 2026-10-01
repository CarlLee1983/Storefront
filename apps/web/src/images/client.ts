import type { ProductImage } from "@storefront/app/product-images";
import { UserFacingError, describeFailure } from "../admin/failure";
import { resizeProductImage } from "./resize";

type Rejected = { ok: false; reason: string; fields?: Record<string, string[]> };

/** 讀取後台圖片 API 的回應：成功回 data，失敗丟出訊息可直接顯示的 `UserFacingError`。 */
export async function readResult<T>(response: Response, imageLabel = "商品圖片"): Promise<T> {
  const result = await response.json() as { ok: true; data: T } | Rejected;
  if (response.ok && result.ok) return result.data;
  const reason = (result as Rejected).reason;
  throw new UserFacingError(reason === "unauthorized"
    ? "沒有權限，請重新通過 Cloudflare Access 登入後再試。"
    : describeFailure(result as Rejected, `${imageLabel}操作失敗，請稍後再試`, imageLabel).message);
}

/** 可顯示的錯誤訊息：`UserFacingError` 用它自己的訊息，其他例外（網路、非預期）一律用通用訊息。 */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof UserFacingError ? cause.message : fallback;
}

/** 在瀏覽器縮圖後上傳一張圖片到後台上傳路由；同一個 `uploadId` 重試時 App 回原圖片。 */
export async function uploadImage(endpoint: string, file: File, uploadId: string, imageLabel: string): Promise<ProductImage> {
  const body = await resizeProductImage(file);
  body.set("uploadId", uploadId);
  const data = await readResult<{ image: ProductImage }>(await fetch(endpoint, { method: "POST", body }), imageLabel);
  return data.image;
}
