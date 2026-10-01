import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { readAccessJwt } from "../../../../admin/access-jwt";
import { parseCategoryId } from "../../../../admin/category-form";
import { handleImageUpload } from "../../../../admin/image-upload-route";
export const prerender = false;
export const POST: APIRoute = ({ request, params, url }) => handleImageUpload({
  request,
  url,
  id: parseCategoryId(params.id),
  notFound: "category_not_found",
  readJwt: () => readAccessJwt(request, env, import.meta.env.DEV),
  check: (jwt, id) => env.APP.getCategoryForAdmin(jwt, { id }),
  save: (jwt, input) => env.APP.setCategoryImage(jwt, input),
});
