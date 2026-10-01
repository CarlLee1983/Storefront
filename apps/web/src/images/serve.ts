/** Read-only by construction: this handler cannot put or delete bucket objects. */
export interface ImageBucket {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; httpEtag: string; size: number } | null>;
}
export const IMAGE_KEY = /^products\/[1-9][0-9]*\/[0-9a-f-]{36}\/[0-9a-f]{64}\.webp$/;
export async function serveImage(bucket: ImageBucket, key: string | undefined): Promise<Response> {
  if (!key || !IMAGE_KEY.test(key)) return new Response("Not Found", { status: 404 });
  const image = await bucket.get(key);
  if (!image) return new Response("Not Found", { status: 404 });
  return new Response(image.body, { headers: {
    "content-type": "image/webp",
    "content-length": String(image.size),
    "cache-control": "public, max-age=31536000, immutable",
    etag: image.httpEtag,
    "x-content-type-options": "nosniff",
  } });
}
