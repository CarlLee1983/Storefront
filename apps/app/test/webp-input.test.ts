import { describe, expect, it } from "vitest";
import { addProductImageInput, webpDimensions } from "../src/images/input";
import { imageVariants } from "./images";

function chunk(name: string, payload: Uint8Array) {
  const result = new Uint8Array(8 + payload.length + payload.length % 2);
  result.set(new TextEncoder().encode(name));
  new DataView(result.buffer).setUint32(4, payload.length, true);
  result.set(payload, 8);
  return result;
}
function riff(...chunks: Uint8Array[]) {
  const result = new Uint8Array(12 + chunks.reduce((sum, item) => sum + item.length, 0));
  result.set(new TextEncoder().encode("RIFF"));
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  result.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  for (const item of chunks) { result.set(item, offset); offset += item.length; }
  return result;
}
function extendedPayload(width = 320, height = 240, flags = 0) {
  const result = new Uint8Array(10);
  result[0] = flags;
  new DataView(result.buffer).setUint32(4, width - 1, true);
  result[7] = (height - 1) & 255;
  result[8] = ((height - 1) >>> 8) & 255;
  result[9] = ((height - 1) >>> 16) & 255;
  return result;
}
const lossy = () => imageVariants()[0]!.bytes.slice(12);

/** These structural tests deliberately modify headers; RPC fixtures contain real encoded pixels. */
describe("WebP 結構與尺寸驗證", () => {
  it("讀取 lossy VP8 與 extended VP8X 的實際尺寸", () => {
    expect(webpDimensions(imageVariants()[0]!.bytes)).toEqual({ width: 320, height: 240 });
    expect(webpDimensions(riff(chunk("VP8X", extendedPayload()), lossy()))).toEqual({ width: 320, height: 240 });
  });

  it("支援 VP8L lossless header", () => {
    const data = new Uint8Array(6);
    data[0] = 0x2f;
    new DataView(data.buffer).setUint32(1, (320 - 1) | ((240 - 1) << 14), true);
    expect(webpDimensions(riff(chunk("VP8L", data)))).toEqual({ width: 320, height: 240 });
    data[4] = 0xe0;
    expect(webpDimensions(riff(chunk("VP8L", data)))).toBeNull();
    data[0] = 0;
    expect(webpDimensions(riff(chunk("VP8L", data)))).toBeNull();
  });

  it("拒絕假的 RIFF、大小不符、chunk 超出長度、截斷與多餘位元組", () => {
    const bytes = imageVariants()[0]!.bytes;
    expect(webpDimensions(bytes.slice(0, 10))).toBeNull();
    const wrongRiff = bytes.slice(); wrongRiff[0] = 0;
    expect(webpDimensions(wrongRiff)).toBeNull();
    const wrongWebp = bytes.slice(); wrongWebp[8] = 0;
    expect(webpDimensions(wrongWebp)).toBeNull();
    expect(webpDimensions(bytes.slice(0, -1))).toBeNull();
    const oversizedChunk = bytes.slice(); new DataView(oversizedChunk.buffer).setUint32(16, bytes.length, true);
    expect(webpDimensions(oversizedChunk)).toBeNull();
    const trailing = riff(lossy(), new Uint8Array(1));
    expect(webpDimensions(trailing)).toBeNull();
    expect(webpDimensions(riff(chunk("JUNK", new Uint8Array(3))))).toBeNull();
  });

  it("拒絕動畫、多個 frame、非 keyframe 與無效的 VP8 signature", () => {
    expect(webpDimensions(riff(chunk("VP8X", extendedPayload(320, 240, 2)), lossy()))).toBeNull();
    expect(webpDimensions(riff(chunk("ANIM", new Uint8Array(6)), lossy()))).toBeNull();
    expect(webpDimensions(riff(chunk("ANMF", new Uint8Array(6)), lossy()))).toBeNull();
    expect(webpDimensions(riff(lossy(), lossy()))).toBeNull();
    const frame = lossy(); frame[8] = frame[8]! | 1;
    expect(webpDimensions(riff(frame))).toBeNull();
    frame[8] = frame[8]! & ~1; frame[11] = 0;
    expect(webpDimensions(riff(frame))).toBeNull();
    expect(webpDimensions(riff(chunk("VP8 ", new Uint8Array(10))))).toBeNull();
  });

  it("拒絕無效的 VP8X、不同 canvas/frame 尺寸與零尺寸", () => {
    expect(webpDimensions(riff(chunk("VP8X", extendedPayload(640)), lossy()))).toBeNull();
    expect(webpDimensions(riff(chunk("VP8X", extendedPayload()), chunk("VP8X", extendedPayload()), lossy()))).toBeNull();
    expect(webpDimensions(riff(lossy(), chunk("VP8X", extendedPayload())))).toBeNull();
    expect(webpDimensions(riff(chunk("VP8X", new Uint8Array(9)), lossy()))).toBeNull();
    const payload = extendedPayload(); payload[1] = 1;
    expect(webpDimensions(riff(chunk("VP8X", payload), lossy()))).toBeNull();
    const frame = lossy(); frame[14] = 0; frame[15] = 0;
    expect(webpDimensions(riff(frame))).toBeNull();
  });

  it("允許帶 metadata 與奇數長度 chunk 的静態 WebP", () => {
    expect(webpDimensions(riff(chunk("VP8X", extendedPayload()), lossy(), chunk("XMP ", new Uint8Array(3)))))
      .toEqual({ width: 320, height: 240 });
  });

  it("三種尺寸必須保持同一比例，容許四捨五入的 1px 差異", () => {
    const variants = imageVariants();
    // 修改 frame 標頭以單獨驗證比例檢查；這不是有效像素解碼測試。
    variants[0]!.height = 242;
    new DataView(variants[0]!.bytes.buffer).setUint16(28, 242, true);
    expect(addProductImageInput.safeParse({ id: 1, uploadId: crypto.randomUUID(), variants }).success).toBe(false);
    variants[0]!.height = 241;
    new DataView(variants[0]!.bytes.buffer).setUint16(28, 241, true);
    expect(addProductImageInput.safeParse({ id: 1, uploadId: crypto.randomUUID(), variants }).success).toBe(true);
    expect(addProductImageInput.safeParse({ id: 1, uploadId: crypto.randomUUID(), variants: [] }).success).toBe(false);
  });
});
