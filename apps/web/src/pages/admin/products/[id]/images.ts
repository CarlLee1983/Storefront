import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { readAccessJwt } from "../../../../admin/access-jwt";
import { handleImageUpload } from "../../../../admin/image-upload-route";
import { parseProductId } from "../../../../admin/product-form";
export const prerender = false;
export const POST: APIRoute = ({ request, params, url }) => handleImageUpload({
  request,
  url,
  id: parseProductId(params.id),
  notFound: "product_not_found",
  readJwt: () => readAccessJwt(request, env, import.meta.env.DEV),
  check: (jwt, id) => env.APP.getProductForAdmin(jwt, { id }),
  save: (jwt, input) => env.APP.addProductImage(jwt, input),
});
