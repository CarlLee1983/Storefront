/** 上傳端與讀取端共同的商品圖片格式；不保存原圖。 */
export const IMAGE_WIDTHS = [320, 640, 1280] as const;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PRODUCT_IMAGES = 8;
export const MAX_IMAGE_HEIGHT = 8192;

export interface ProductImage {
  id: string;
  variants: Array<{ key: string; width: number; height: number }>;
}
