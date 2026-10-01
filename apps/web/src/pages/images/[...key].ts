import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { serveImage } from "../../images/serve";
export const prerender = false;
export const GET: APIRoute = ({ params }) => serveImage(env.PRODUCT_IMAGES, params.key);
