/** 以網址為鍵的邊緣快取（Workers Cache API）：命中直接回，沒命中就產生並在回應之後寫入；只快取 200，快取時間由回應的 `cache-control` 決定。 */
export async function withEdgeCache(
  url: URL,
  context: { waitUntil(promise: Promise<unknown>): void },
  build: () => Promise<Response>,
  cache: Pick<Cache, "match" | "put">,
): Promise<Response> {
  const key = new Request(url.href);
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await build();
  if (response.status === 200) context.waitUntil(cache.put(key, response.clone()));
  return response;
}

/** Workers 的預設快取；`astro check` 用的是瀏覽器的 CacheStorage 型別，沒有 `default`，所以在這裡補型別。 */
export const workersCache = () => (caches as unknown as { default: Cache }).default;
