import { describe, expect, it } from "vitest";
import { HERO_INTERVAL_MS, indexFromScroll, stepIndex } from "./carousel";

describe("stepIndex", () => {
  it("往後與往前移動，頭尾相接", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(1, -1, 3)).toBe(0);
  });
});

describe("indexFromScroll", () => {
  it("依捲動位置四捨五入到最近的一張", () => {
    expect(indexFromScroll(0, 400, 3)).toBe(0);
    expect(indexFromScroll(190, 400, 3)).toBe(0);
    expect(indexFromScroll(210, 400, 3)).toBe(1);
    expect(indexFromScroll(800, 400, 3)).toBe(2);
  });

  it("超出範圍時夾在頭尾；寬度為 0 時回第一張", () => {
    expect(indexFromScroll(-30, 400, 3)).toBe(0);
    expect(indexFromScroll(5000, 400, 3)).toBe(2);
    expect(indexFromScroll(100, 0, 3)).toBe(0);
  });
});

describe("HERO_INTERVAL_MS", () => {
  it("每 6 秒切換一次", () => {
    expect(HERO_INTERVAL_MS).toBe(6000);
  });
});
