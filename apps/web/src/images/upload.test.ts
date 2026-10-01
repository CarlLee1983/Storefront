import { describe, expect, it } from "vitest";
import { IMAGE_WIDTHS, MAX_IMAGE_BYTES } from "@storefront/app/product-images";
import { imageUploadInput } from "./upload";
function form() {
  const f = new FormData();
  f.set("uploadId", "00000000-0000-4000-8000-000000000000");
  for (const width of IMAGE_WIDTHS) { f.set(`image-${width}`, new File(["image"], "image.webp", { type: "image/webp" })); f.set(`height-${width}`, String(width)); }
  return f;
}
const request = (body: FormData) => new Request("https://example.com", { method: "POST", body });
describe("bounded multipart upload", () => {
  it("converts all variants to binary RPC data", async () => {
    const input = await imageUploadInput(request(form()), 2);
    expect(input.id).toBe(2);
    expect(input.variants.map(v => [v.width, v.height, [...v.bytes]])).toEqual(IMAGE_WIDTHS.map(w => [w, w, [105,109,97,103,101]]));
  });
  it("rejects missing body and declared oversized body", async () => {
    await expect(imageUploadInput(new Request("https://example.com"), 1)).rejects.toThrow("empty_body");
    await expect(imageUploadInput(new Request("https://example.com", { headers: { "content-length": "999999999" } }), 1)).rejects.toThrow("too_large");
  });
  it("limits chunked bytes without Content-Length", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_IMAGE_BYTES * 4)); c.close(); } });
    await expect(imageUploadInput(new Request("https://example.com", { method: "POST", body: stream, duplex: "half" } as RequestInit), 1)).rejects.toThrow("too_large");
  });
  it.each(["missing", "duplicate", "type", "size", "height", "empty"])("rejects invalid file: %s", async kind => {
    const f = form();
    if (kind === "missing") f.delete("image-320");
    if (kind === "duplicate") f.append("image-320", f.get("image-320")!);
    if (kind === "type") f.set("image-320", new File(["x"], "x.png", { type: "image/png" }));
    if (kind === "size") f.set("image-320", new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "x.webp", { type: "image/webp" }));
    if (kind === "empty") f.set("image-320", new File([], "x.webp", { type: "image/webp" }));
    if (kind === "height") f.set("height-320", "0");
    await expect(imageUploadInput(request(f), 1)).rejects.toThrow();
  });
});
