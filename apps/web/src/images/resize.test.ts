import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "@storefront/app/product-images";
import { UserFacingError } from "../admin/failure";
import { MAX_SOURCE_BYTES, resizeProductImage, targetHeight, validateSource } from "./resize";
afterEach(() => vi.unstubAllGlobals());
describe("browser image resize", () => {
  it("bounds input size and supported formats", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) expect(() => validateSource({ type, size: 1 })).not.toThrow();
    for (const file of [{ type: "image/svg+xml", size: 1 }, { type: "image/png", size: 0 }, { type: "image/png", size: MAX_SOURCE_BYTES + 1 }]) expect(() => validateSource(file)).toThrow();
  });
  it("rejections are user-facing errors, so pages can show their message", () => {
    expect(() => validateSource({ type: "image/svg+xml", size: 1 })).toThrow(UserFacingError);
    expect(() => targetHeight(0, 1, 320)).toThrow(UserFacingError);
  });
  it("keeps aspect ratio and rejects unsafe dimensions", () => {
    expect(targetHeight(1600, 1000, 320)).toBe(200);
    for (const pair of [[0, 1], [1, 0], [10000, 10000], [1, 100]]) expect(() => targetHeight(pair[0]!, pair[1]!, 1280)).toThrow();
  });
  function mocks(blob: Blob | null = new Blob(["resized"], { type: "image/webp" }), hasContext = true) {
    const close = vi.fn();
    const drawImage = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1600, height: 1000, close })));
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => hasContext ? { drawImage } : null, toBlob: (callback: (b: Blob | null) => void) => callback(blob) }) });
    return { close, drawImage };
  }
  it("only sends three resized WebPs, releases bitmap", async () => {
    const { close, drawImage } = mocks();
    const form = await resizeProductImage(new File(["original"], "photo.png", { type: "image/png" }));
    expect([...form.keys()]).toEqual(["image-320", "height-320", "image-640", "height-640", "image-1280", "height-1280"]);
    expect(form.get("height-320")).toBe("200");
    expect(await (form.get("image-320") as File).text()).toBe("resized");
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([null, new Blob(["png"], { type: "image/png" }), new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: "image/webp" })])("releases bitmap when encoding fails", async blob => {
    const { close } = mocks(blob);
    await expect(resizeProductImage(new File(["x"], "photo.png", { type: "image/png" }))).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
  it("handles canvas unavailable", async () => {
    const { close } = mocks(null, false);
    await expect(resizeProductImage(new File(["x"], "photo.png", { type: "image/png" }))).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
});
