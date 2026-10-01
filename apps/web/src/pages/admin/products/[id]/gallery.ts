import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { readAccessJwt } from "../../../../admin/access-jwt";
import { parseProductId } from "../../../../admin/product-form";
export const prerender = false;
const json = (value: unknown, status: number) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export const ALL: APIRoute = async ({ request, params, url }) => {
  const method = request.method;
  if (!["GET", "PUT", "DELETE"].includes(method)) return json({ ok: false, reason: "invalid_input" }, 405);
  if (method !== "GET" && request.headers.get("origin") !== url.origin) return json({ ok: false, reason: "unauthorized" }, 403);
  const id = parseProductId(params.id);
  if (id === null) return json({ ok: false, reason: "product_not_found" }, 404);
  const jwt = readAccessJwt(request, env, import.meta.env.DEV);
  try {
    const product = await env.APP.getProductForAdmin(jwt, { id });
    if (!product.ok) return json(product, product.reason === "unauthorized" ? 403 : 404);
    if (method === "GET") return json(product, 200);
    let input: Record<string, unknown>;
    try {
      const reader = request.body?.getReader();
      if (!reader) throw new Error("empty");
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 4096) { await reader.cancel(); throw new Error("too_large"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      input = JSON.parse(new TextDecoder().decode(bytes));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid");
    } catch { return json({ ok: false, reason: "invalid_input" }, 400); }
    const result = method === "PUT"
      ? await env.APP.reorderProductImages(jwt, { id, imageIds: input.imageIds })
      : await env.APP.deleteProductImage(jwt, { id, imageId: input.imageId });
    return json(result, result.ok ? 200 : result.reason === "unauthorized" ? 403 : result.reason === "image_delete_failed" ? 503 : 400);
  } catch { return json({ ok: false, reason: "image_management_failed" }, 503); }
};
