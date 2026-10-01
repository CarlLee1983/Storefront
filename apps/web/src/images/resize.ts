import { IMAGE_WIDTHS, MAX_IMAGE_BYTES } from "@storefront/app/product-images";
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export function validateSource(file: Pick<File, "size" | "type">): void {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size === 0 || file.size > MAX_SOURCE_BYTES) {
    throw new Error("請選擇 20 MB 以內的 JPEG、PNG 或 WebP 圖片。");
  }
}
export function targetHeight(width: number, height: number, targetWidth: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 40_000_000) throw new Error("圖片尺寸過大或無效。");
  const result = Math.max(1, Math.round(height * targetWidth / width));
  if (result > 8192) throw new Error("圖片比例過長，請裁切後再上傳。");
  return result;
}
/** Only these resized WebP blobs leave the browser; the original is never sent. */
export async function resizeProductImage(file: File): Promise<FormData> {
  validateSource(file);
  const bitmap = await createImageBitmap(file);
  try {
    const form = new FormData();
    for (const width of IMAGE_WIDTHS) {
      const height = targetHeight(bitmap.width, bitmap.height, width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("瀏覽器無法處理圖片，請更換瀏覽器再試。");
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.82));
      canvas.width = canvas.height = 0;
      if (!blob || blob.type !== "image/webp" || blob.size > MAX_IMAGE_BYTES) throw new Error("圖片轉換失敗或檔案過大，請換一張圖片再試。");
      form.set(`image-${width}`, blob, `${width}.webp`);
      form.set(`height-${width}`, String(height));
    }
    return form;
  } finally { bitmap.close(); }
}
