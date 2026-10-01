import { z } from "zod";
import { productIdInput } from "../admin/input";
import { IMAGE_WIDTHS, MAX_IMAGE_BYTES, MAX_IMAGE_HEIGHT } from "../product-images";

const ascii = (bytes: Uint8Array, offset: number, value: string) =>
  [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
const uint24 = (bytes: Uint8Array, offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);

/**
 * 檢查 RIFF 容器、靜態 WebP frame header 與實際尺寸，不信任呼叫端的 MIME 或尺寸。
 * Workers 沒有圖片解碼器；這裡驗證格式標頭而非解碼壓縮像素。瀏覽器負責解碼與重新編碼來源圖片。
 */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 26 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.length - 8) return null;
  let frame: { width: number; height: number } | null = null;
  let canvas: { width: number; height: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end + (size % 2) > bytes.length) return null;
    if (ascii(bytes, offset, "VP8 ")) {
      if (frame || size <= 10 || (bytes[start]! & 1) !== 0 || !ascii(bytes, start + 3, "\x9d\x01\x2a")) return null;
      frame = { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff };
    } else if (ascii(bytes, offset, "VP8L")) {
      if (frame || size <= 5 || bytes[start] !== 0x2f || (bytes[start + 4]! & 0xe0) !== 0) return null;
      const bits = view.getUint32(start + 1, true);
      frame = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (ascii(bytes, offset, "VP8X")) {
      if (canvas || offset !== 12 || size !== 10 || (bytes[start]! & 0xc3) !== 0 || uint24(bytes, start + 1) !== 0) return null;
      canvas = { width: uint24(bytes, start + 4) + 1, height: uint24(bytes, start + 7) + 1 };
    } else if (ascii(bytes, offset, "ANIM") || ascii(bytes, offset, "ANMF")) {
      return null;
    }
    offset = end + (size % 2);
  }
  if (offset !== bytes.length || !frame || frame.width === 0 || frame.height === 0) return null;
  if (canvas && (canvas.width !== frame.width || canvas.height !== frame.height)) return null;
  return frame;
}

const variant = z.object({
  width: z.number().int(),
  height: z.number().int().min(1).max(MAX_IMAGE_HEIGHT),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES, "每個尺寸的圖片不可超過 2 MiB"),
}).superRefine((value, ctx) => {
  const actual = webpDimensions(value.bytes);
  if (!actual || actual.width !== value.width || actual.height !== value.height) {
    ctx.addIssue({ code: "custom", message: "圖片必須是尺寸正確的靜態 WebP", path: ["bytes"] });
  }
});

export const addProductImageInput = productIdInput.extend({
  uploadId: z.uuid({ error: "上傳識別碼必須是 UUID" }),
  variants: z.array(variant).length(IMAGE_WIDTHS.length, "必須提供所有圖片尺寸"),
}).superRefine(({ variants }, ctx) => {
  const sorted = [...variants].sort((a, b) => a.width - b.width);
  if (sorted.some((value, index) => value.width !== IMAGE_WIDTHS[index])) {
    ctx.addIssue({ code: "custom", message: "圖片尺寸不可重複或缺漏", path: ["variants"] });
  }
  const largest = sorted.at(-1);
  if (largest && sorted.some(({ width, height }) => Math.abs(height - largest.height * width / largest.width) > 1)) {
    ctx.addIssue({ code: "custom", message: "各尺寸必須保持相同比例", path: ["variants"] });
  }
});

export type AddProductImageInput = z.output<typeof addProductImageInput>;
