export const CHECKOUT_KEY_STORAGE_KEY = "storefront.checkout-key";

/** 只用到 Storage 的這三個方法，測試可以用假物件。 */
export type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 取得瀏覽器的 sessionStorage；隱私設定可能讓存取本身丟例外，此時回傳 null。 */
export function sessionStorageOf(win: { sessionStorage: KeyStorage }): KeyStorage | null {
  try {
    return win.sessionStorage;
  } catch {
    return null;
  }
}

function readStored(storage: KeyStorage | null): { key: string; fingerprint: string } | null {
  const raw = storage?.getItem(CHECKOUT_KEY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data === "object" && data !== null && "key" in data && "fingerprint" in data) {
      const { key, fingerprint } = data;
      if (typeof key === "string" && typeof fingerprint === "string") return { key, fingerprint };
    }
  } catch {
    // 壞掉的內容當作沒有
  }
  return null;
}

/**
 * 這一次結帳的冪等鍵：連同結帳內容的指紋存在 sessionStorage。內容相同（連點、網路不穩後再按）沿用同一個鍵；
 * 內容不同（購物車或收件資訊改了）就換新鍵，因為 App 對「同一個鍵、不同內容」回 `idempotency_key_reused`。
 * 存取失敗時退而求其次回傳新鍵——只是失去「重送沿用」，不影響結帳本身。
 */
export function getOrCreateIdempotencyKey(storage: KeyStorage | null, generate: () => string, fingerprint: string): string {
  try {
    const stored = readStored(storage);
    if (stored?.fingerprint === fingerprint) return stored.key;
    const key = generate();
    storage?.setItem(CHECKOUT_KEY_STORAGE_KEY, JSON.stringify({ key, fingerprint }));
    return key;
  } catch {
    return generate();
  }
}

/** 結帳成功後清掉，下一次結帳用新的鍵；失敗不丟例外。 */
export function clearIdempotencyKey(storage: KeyStorage | null): void {
  try {
    storage?.removeItem(CHECKOUT_KEY_STORAGE_KEY);
  } catch {
    // sessionStorage 不可用時本來就沒有存鍵
  }
}
