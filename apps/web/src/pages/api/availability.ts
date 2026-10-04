import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const variantIds = (url.searchParams.get("variants") ?? "").split(",").filter(Boolean).map(Number);
  try {
    const result = await env.APP.getAvailability({ variantIds });
    return Response.json(result.ok ? result.data : { error: result.reason }, {
      status: result.ok ? 200 : 400,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
};
