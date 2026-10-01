/**
 * seed 的目標環境。只有本機與 preview 兩種；production 與任何不認得的目標都在開瀏覽器之前就拒絕，
 * 所以拒絕時不會有任何寫入。
 */
export const PREVIEW_URL = "https://storefront-preview.gravito.dev";
/** `bun run dev`（astro dev）的預設網址。 */
export const LOCAL_DEFAULT_URL = "http://localhost:4321";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const USAGE = "用法：bun run seed <local [本機網址] | preview>";

export interface SeedTarget {
  name: "local" | "preview";
  /** 不含結尾斜線的 origin。 */
  baseUrl: string;
  /** preview 的後台在 Cloudflare Access 後面：要開有畫面的 Chrome 讓 owner 手動登入。 */
  interactiveLogin: boolean;
}

export function resolveSeedTarget(args: readonly string[]): SeedTarget {
  const [target, url] = args;
  if (target?.toLowerCase() === "production") throw new Error("拒絕對 production 執行 seed：示範資料只寫入本機與 preview。");
  if (target === "preview") {
    if (url !== undefined) throw new Error(`preview 不接受網址參數，固定使用 ${PREVIEW_URL}。`);
    return { name: "preview", baseUrl: PREVIEW_URL, interactiveLogin: true };
  }
  if (target === "local") return { name: "local", baseUrl: parseLoopbackOrigin(url ?? LOCAL_DEFAULT_URL), interactiveLogin: false };
  throw new Error(`目標必須是 local 或 preview。${USAGE}`);
}

function parseLoopbackOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new Error(`不是合法的網址：${url}`, { cause });
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) throw new Error(`local 只接受本機網址（localhost、127.0.0.1、[::1]），收到 ${parsed.host}。`);
  return parsed.origin;
}
