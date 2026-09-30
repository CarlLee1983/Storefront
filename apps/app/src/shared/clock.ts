/** 應用層取得「現在」的唯一途徑；回傳 UTC epoch 毫秒。 */
export interface Clock {
  now(): number;
}

/**
 * 正式時鐘，由組合根（entrypoint）傳給各 service。
 * 測試與 main Worker 同處一個 isolate，偽造 `Date` 即可影響它（見 test/clock.ts）。
 */
export const systemClock: Clock = { now: () => Date.now() };
