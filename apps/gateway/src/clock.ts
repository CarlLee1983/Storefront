/** 取得「現在」的唯一途徑；回傳 UTC epoch 毫秒。測試偽造 `Date` 即可影響它（見 test/clock.ts）。 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
