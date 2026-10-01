import { imageUploadInput } from "../images/upload";

type Rpc = { ok: true } | { ok: false; reason: string };

interface ImageUploadRoute {
  request: Request;
  url: URL;
  /** 網址上的編號；不合法為 null。 */
  id: number | null;
  /** 編號不合法時回的 reason（商品或分類不存在）。 */
  notFound: string;
  readJwt: () => string;
  /** 預先驗證：確認管理員身分與對象存在，通過才讀取上傳內容。 */
  check: (jwt: string, id: number) => Promise<Rpc>;
  save: (jwt: string, input: Awaited<ReturnType<typeof imageUploadInput>>) => Promise<Rpc>;
}

const json = (value: unknown, status: number) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** 圖片上傳 RPC 失敗原因 → HTTP 狀態：授權 403、儲存暫時失敗 503（可重試），其餘 400。 */
const saveStatus = (reason: string) => reason === "unauthorized" ? 403 : reason === "image_upload_failed" ? 503 : 400;

/**
 * 商品圖片與分類圖片的後台上傳路由共用流程：檢查 Origin、轉交 Access JWT、先預先驗證再讀上傳內容
 *（未授權不緩衝 multipart）、呼叫 App 儲存。App 會再驗一次 JWT。
 */
export async function handleImageUpload({ request, url, id, notFound, readJwt, check, save }: ImageUploadRoute): Promise<Response> {
  if (request.headers.get("origin") !== url.origin) return json({ ok: false, reason: "unauthorized" }, 403);
  if (id === null) return json({ ok: false, reason: notFound }, 404);
  const jwt = readJwt();
  try {
    const found = await check(jwt, id);
    if (!found.ok) return json(found, found.reason === "unauthorized" ? 403 : 404);
  } catch { return json({ ok: false, reason: "image_upload_failed" }, 503); }
  let input;
  try { input = await imageUploadInput(request, id); }
  catch { return json({ ok: false, reason: "invalid_input" }, 400); }
  try {
    const result = await save(jwt, input);
    return json(result, result.ok ? 201 : saveStatus(result.reason));
  } catch { return json({ ok: false, reason: "image_upload_failed" }, 503); }
}
