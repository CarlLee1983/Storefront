import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { readAccessJwt } from "../../../../admin/access-jwt";
import { parseProductId } from "../../../../admin/product-form";
import { imageUploadInput } from "../../../../images/upload";
export const prerender = false;
const json = (value: unknown, status: number) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export const POST: APIRoute = async ({ request, params, url }) => {
  if (request.headers.get("origin") !== url.origin) return json({ ok: false, reason: "unauthorized" }, 403);
  const id = parseProductId(params.id);
  if (id === null) return json({ ok: false, reason: "product_not_found" }, 404);
  const jwt = readAccessJwt(request, env, import.meta.env.DEV);
  // Authenticate before buffering multipart bytes. The mutating RPC verifies again.
  let product;
  try { product = await env.APP.getProductForAdmin(jwt, { id }); }
  catch { return json({ ok: false, reason: "image_upload_failed" }, 503); }
  if (!product.ok) return json(product, product.reason === "unauthorized" ? 403 : 404);
  let input;
  try { input = await imageUploadInput(request, id); }
  catch { return json({ ok: false, reason: "invalid_input" }, 400); }
  try {
    const result = await env.APP.addProductImage(jwt, input);
    return json(result, result.ok ? 201 : result.reason === "unauthorized" ? 403 : result.reason === "image_upload_failed" ? 503 : 400);
  } catch { return json({ ok: false, reason: "image_upload_failed" }, 503); }
};
