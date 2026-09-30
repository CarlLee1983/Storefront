import { afterEach, vi } from "vitest";

/**
 * 全域 fetch 的唯一攔截點：測試替身（OAuth provider、金流閘道）各自登記一條「網址比對 → 回應」的路由，
 * 沒有任何路由符合的請求照常送出。這樣替身之間不會互相蓋掉，登記的先後順序不影響結果。
 * main Worker 與測試同處一個 isolate，所以 App 內的 fetch 也會被攔截。
 */
type Handler = (request: Request) => Response | Promise<Response>;
interface Route {
  matches: (url: string) => boolean;
  handle: Handler;
}

const realFetch = globalThis.fetch;
const routes = new Map<string, Route>();

async function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  for (const route of routes.values()) {
    if (route.matches(url)) return route.handle(new Request(input, init));
  }
  return realFetch(input, init);
}

/** 登記（或以同名覆蓋）一條路由；必要時才安裝 fetch 的 spy。 */
export function registerFetchRoute(name: string, matches: (url: string) => boolean, handle: Handler): void {
  routes.set(name, { matches, handle });
  if (!vi.isMockFunction(globalThis.fetch)) vi.spyOn(globalThis, "fetch").mockImplementation(dispatch);
}

afterEach(() => routes.clear());
