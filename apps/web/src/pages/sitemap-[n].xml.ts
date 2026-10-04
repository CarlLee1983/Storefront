import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { withEdgeCache, workersCache } from "../seo/edge-cache";
import { siteOrigin } from "../seo/site-origin";
import { urlsetXml } from "../seo/sitemap";
import { loadSitemapChunks } from "../seo/sitemap-source";

export const prerender = false;

export const GET: APIRoute = ({ params, url, locals }) =>
  withEdgeCache(url, locals.cfContext, async () => {
    const index = /^[1-9]\d*$/.test(params.n ?? "") ? Number(params.n) - 1 : -1;
    const chunks = await loadSitemapChunks(env.APP);
    // 只有一個檔時內容就在 /sitemap.xml，分檔網址不存在
    const chunk = chunks.length > 1 ? chunks[index] : undefined;
    if (!chunk) return new Response("Not found", { status: 404 });
    return new Response(urlsetXml(siteOrigin(env.SITE_ORIGIN, url), chunk), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
  }, workersCache());
