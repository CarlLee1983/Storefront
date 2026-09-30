/** 登入頁與登出按鈕的瀏覽器端請求邏輯；抽出來以便用假的 fetch 測試失敗路徑。 */

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/**
 * 發起 LINE / Google 登入，回傳 provider 的授權網址；任何失敗（網路錯誤、非 2xx、回應不是 JSON 或沒有 url）都回 null。
 * 先看 `response.ok` 再解析 body：500 的回應通常不是 JSON。
 */
export async function requestSocialLogin(
  fetchFn: FetchFn,
  provider: string,
  callbackURL: string,
): Promise<string | null> {
  try {
    const response = await fetchFn("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, callbackURL }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { url?: unknown };
    return typeof body.url === "string" && body.url ? body.url : null;
  } catch {
    return null;
  }
}

/** 登出；只有回應 ok 才回 true，網路錯誤也回 false。 */
export async function requestSignOut(fetchFn: FetchFn): Promise<boolean> {
  try {
    const response = await fetchFn("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}
