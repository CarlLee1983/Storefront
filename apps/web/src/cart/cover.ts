import { IMAGE_KEY } from "../images/serve";

/** Optional add-time snapshot; older carts remain readable without an image. */
export interface CartCover {
  variants: Array<{ key: string; width: number; height: number }>;
}

/** Ignore invalid optional images without discarding an otherwise usable cart. */
export function parseCartCover(value: unknown): CartCover | undefined {
  if (typeof value !== "object" || value === null || !("variants" in value) || !Array.isArray(value.variants)) return;
  if (value.variants.length < 1 || value.variants.length > 3) return;
  const variants: CartCover["variants"] = [];
  for (const variant of value.variants) {
    if (typeof variant !== "object" || variant === null) return;
    const { key, width, height } = variant;
    if (typeof key !== "string" || !IMAGE_KEY.test(key) || ![320, 640, 1280].includes(width) || !Number.isSafeInteger(height) || height < 1 || height > 8192) return;
    if (variants.some(variant => variant.width === width)) return;
    variants.push({ key, width, height });
  }
  return { variants: variants.sort((a, b) => a.width - b.width) };
}

/** Client-created cover for cart/checkout; never uses localStorage strings as HTML. */
export function createCartCover(cover: CartCover | undefined, name: string): HTMLElement {
  const frame = document.createElement("span");
  frame.className = "cart-cover";
  const placeholder = document.createElement("span");
  placeholder.className = "cover-placeholder";
  placeholder.textContent = "暫無圖片";
  frame.appendChild(placeholder);
  const variant = cover?.variants[0];
  if (variant) {
    const image = document.createElement("img");
    image.alt = `${name}的封面`;
    image.width = variant.width;
    image.height = variant.height;
    image.loading = "lazy";
    image.addEventListener("error", () => { image.remove(); placeholder.hidden = false; }, { once: true });
    image.srcset = cover!.variants.map(v => `/images/${v.key} ${v.width}w`).join(", ");
    image.sizes = "80px";
    image.src = `/images/${variant.key}`;
    placeholder.hidden = true;
    frame.appendChild(image);
  }
  return frame;
}
