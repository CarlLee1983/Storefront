/** 所有 JSON API 的回應形狀：`{ ok: true, data }` 或 `{ ok: false, error: { code, message, fields? } }`。 */
export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string[]>;
}

export const success = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status });

export const failure = (status: number, code: string, message: string, fields?: Record<string, string[]>) =>
  Response.json(
    { ok: false, error: { code, message, ...(fields ? { fields } : {}) } satisfies ApiErrorBody },
    { status },
  );

/** 常數時間比較（先雜湊成等長再比），避免從回應時間推測金鑰。 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all(
    [a, b].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  const bytesA = new Uint8Array(hashA!);
  const bytesB = new Uint8Array(hashB!);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i]! ^ bytesB[i]!;
  return diff === 0;
}

export async function hasBearerKey(request: Request, apiKey: string): Promise<boolean> {
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  return match !== null && (await safeEqual(match[1]!, apiKey));
}
