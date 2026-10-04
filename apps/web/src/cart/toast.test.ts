import { afterEach, expect, test, vi } from "vitest";
import { clearCartToast, showCartToast } from "./toast";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

test("announces feedback then clears it after five seconds", () => {
  vi.useFakeTimers();
  const region = { textContent: "" } as HTMLElement;
  showCartToast(region, "已加入購物車");
  vi.advanceTimersByTime(30);
  expect(region.textContent).toBe("已加入購物車");
  vi.advanceTimersByTime(5000);
  expect(region.textContent).toBe("");
});

test("the most recent add wins and resets the expiry, including identical feedback", () => {
  vi.useFakeTimers();
  const first = { textContent: "" } as HTMLElement;
  const second = { textContent: "" } as HTMLElement;
  showCartToast(first, "第一件");
  showCartToast(second, "第二件");
  vi.advanceTimersByTime(30);
  expect(first.textContent).toBe("");
  expect(second.textContent).toBe("第二件");
  vi.advanceTimersByTime(4000);
  showCartToast(second, "第二件");
  expect(second.textContent).toBe("");
  vi.advanceTimersByTime(30);
  expect(second.textContent).toBe("第二件");
  vi.advanceTimersByTime(1000);
  expect(second.textContent).toBe("第二件");
  vi.advanceTimersByTime(4000);
  expect(second.textContent).toBe("");
});

test("starting another request cancels an announcement that has not appeared yet", () => {
  vi.useFakeTimers();
  const region = { textContent: "" } as HTMLElement;
  showCartToast(region, "上一筆成功");
  vi.advanceTimersByTime(10);
  clearCartToast(region);
  vi.advanceTimersByTime(6000);
  expect(region.textContent).toBe("");
  showCartToast(region, "這一筆失敗");
  vi.advanceTimersByTime(30);
  expect(region.textContent).toBe("這一筆失敗");
});
