import { IMAGE_WIDTHS, MAX_IMAGE_BYTES } from "@storefront/app/product-images";

const MAX_BODY = IMAGE_WIDTHS.length * MAX_IMAGE_BYTES + 16_384;
/** Bound multipart bytes even for a chunked request without Content-Length. */
export async function imageUploadInput(request: Request, id: number) {
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new Error("too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) { await reader.cancel(); throw new Error("too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const form = await new Response(bytes, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  const uploadId = form.get("uploadId");
  if (typeof uploadId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId) || form.getAll("uploadId").length !== 1) throw new Error("invalid_upload_id");
  const variants = await Promise.all(IMAGE_WIDTHS.map(async width => {
    const file = form.get(`image-${width}`);
    const height = Number(form.get(`height-${width}`));
    if (!(file instanceof File) || file.type !== "image/webp" || file.size === 0 || file.size > MAX_IMAGE_BYTES || !Number.isSafeInteger(height) || height < 1 || form.getAll(`image-${width}`).length !== 1) throw new Error("invalid_image");
    return { width, height, bytes: new Uint8Array(await file.arrayBuffer()) };
  }));
  return { id, uploadId, variants };
}
