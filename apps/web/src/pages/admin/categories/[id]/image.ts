import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { readAccessJwt } from "../../../../admin/access-jwt";
import { parseCategoryId } from "../../../../admin/category-form";
import { imageUploadInput } from "../../../../images/upload";
export const prerender = false;
const json = (value: unknown, status: number) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const REJECTED_STATUS: Record<string, number> = { unauthorized: 403, category_not_found: 404, image_upload_failed: 503 };
export const POST: APIRoute = async ({ request, params, url }) => {
  if (request.headers.get("origin") !== url.origin) return json({ ok: false, reason: "unauthorized" }, 403);
  const id = parseCategoryId(params.id);
  if (id === null) return json({ ok: false, reason: "category_not_found" }, 404);
  const jwt = readAccessJwt(request, env, import.meta.env.DEV);
  // Authenticate and check the category exists before buffering multipart bytes. The mutating RPC verifies again.
  try {
    const categories = await env.APP.listCategoriesForAdmin(jwt);
    if (!categories.ok) return json(categories, 403);
    if (!categories.data.some((category) => category.id === id)) return json({ ok: false, reason: "category_not_found" }, 404);
  } catch { return json({ ok: false, reason: "image_upload_failed" }, 503); }
  let input;
  try { input = await imageUploadInput(request, id); }
  catch { return json({ ok: false, reason: "invalid_input" }, 400); }
  try {
    const result = await env.APP.setCategoryImage(jwt, input);
    return json(result, result.ok ? 201 : REJECTED_STATUS[result.reason] ?? 400);
  } catch { return json({ ok: false, reason: "image_upload_failed" }, 503); }
};
