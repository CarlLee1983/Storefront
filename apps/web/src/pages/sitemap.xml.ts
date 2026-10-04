import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { withEdgeCache, workersCache } from "../seo/edge-cache";
import { siteOrigin } from "../seo/site-origin";
import { sitemapIndexXml, urlsetXml } from "../seo/sitemap";
import { loadSitemapChunks } from "../seo/sitemap-source";

export const prerender = false;

// 一個檔放得下就直接是 urlset；超過 50,000 個網址時改為 sitemap index，指向 /sitemap-<n>.xml。
// 邊緣快取 5 分鐘（與 cache-control 一致），避免每次爬取都掃一遍商品表
export const GET: APIRoute = ({ url, locals }) =>
  withEdgeCache(url, locals.cfContext, async () => {
    const origin = siteOrigin(env.SITE_ORIGIN, url);
    const chunks = await loadSitemapChunks(env.APP);
    const body = chunks.length === 1 ? urlsetXml(origin, chunks[0]!) : sitemapIndexXml(origin, chunks.length);
    return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
  }, workersCache());
