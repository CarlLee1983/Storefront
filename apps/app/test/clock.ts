import { afterEach, vi } from "vitest";

/**
 * 設定 App Worker 看到的「現在」（UTC epoch 毫秒）。
 *
 * main Worker 與測試跑在同一個 isolate，所以只偽造 `Date` 就會讓 `systemClock`
 * 經由 RPC 呼叫也讀到這個時間；只偽造 Date，避免影響 D1 呼叫用到的計時器。
 */
export function setNow(epochMs: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(epochMs);
}

afterEach(() => {
  vi.useRealTimers();
});
