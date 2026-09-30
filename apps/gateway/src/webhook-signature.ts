/**
 * Webhook 簽章（Stripe 風格），閘道簽發、App 驗證共用同一份。純函式，只用 Web Crypto。
 *
 * Header：`Gateway-Signature: t=<unix 秒>,v1=<hex(HMAC-SHA256(secret, "<t>.<body>"))>`
 * body 是送出的原始 JSON 字串（驗證時必須用未經解析的原文）。
 */

export const SIGNATURE_HEADER = "Gateway-Signature";

/** 預設時間容忍度：timestamp 與驗證當下相差超過 5 分鐘（過去或未來）就拒絕。 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "malformed_header" | "timestamp_out_of_tolerance" | "signature_mismatch" };

const encoder = new TextEncoder();

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** 產生 `Gateway-Signature` header 的值；timestamp 取自 `nowMs`。 */
export async function signWebhook(input: { secret: string; body: string; nowMs: number }): Promise<string> {
  const timestamp = Math.floor(input.nowMs / 1000);
  const key = await hmacKey(input.secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${input.body}`));
  return `t=${timestamp},v1=${toHex(signature)}`;
}

/** 驗證 header：先檢查格式與時間容忍度，再以常數時間比對簽章。 */
export async function verifyWebhookSignature(input: {
  secret: string;
  header: string;
  body: string;
  nowMs: number;
  toleranceSeconds?: number;
}): Promise<VerifyResult> {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(input.header);
  if (!match) return { ok: false, reason: "malformed_header" };

  const timestamp = Number(match[1]);
  const toleranceMs = (input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  if (Math.abs(input.nowMs - timestamp * 1000) > toleranceMs) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const key = await hmacKey(input.secret, "verify");
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromHex(match[2]!),
    encoder.encode(`${timestamp}.${input.body}`),
  );
  return valid ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}
