import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { siteOrigin } from "../seo/site-origin";
import { robotsTxt } from "../seo/sitemap";

export const prerender = false;

export const GET: APIRoute = ({ url }) =>
  new Response(robotsTxt(siteOrigin(env.SITE_ORIGIN, url)), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
