import { afterEach, vi } from "vitest";

/**
 * 設定閘道看到的「現在」（UTC epoch 毫秒）。
 * Worker 與測試在同一個 isolate，只偽造 `Date`，不動 D1 用到的計時器。
 */
export function setNow(epochMs: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(epochMs);
}

afterEach(() => {
  vi.useRealTimers();
});
