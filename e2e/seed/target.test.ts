import { describe, expect, test } from "bun:test";
import { PREVIEW_URL, resolveSeedTarget } from "./target";

describe("resolveSeedTarget", () => {
  test("local 預設指向本機 dev server，不需要手動登入", () => {
    expect(resolveSeedTarget(["local"])).toEqual({ name: "local", baseUrl: "http://localhost:4321", interactiveLogin: false });
  });

  test("local 可以指定其他本機網址", () => {
    expect(resolveSeedTarget(["local", "http://127.0.0.1:8787/"]).baseUrl).toBe("http://127.0.0.1:8787");
  });

  test("local 只接受 loopback 位址", () => {
    expect(() => resolveSeedTarget(["local", "https://storefront-preview.gravito.dev"])).toThrow(/只接受本機/);
    expect(() => resolveSeedTarget(["local", "https://storefront.gravito.dev"])).toThrow(/只接受本機/);
  });

  test("preview 指向 preview 網域，需要 owner 在瀏覽器手動登入", () => {
    expect(resolveSeedTarget(["preview"])).toEqual({ name: "preview", baseUrl: PREVIEW_URL, interactiveLogin: true });
  });

  test("preview 不接受自訂網址", () => {
    expect(() => resolveSeedTarget(["preview", "https://storefront.gravito.dev"])).toThrow(/不接受網址/);
  });

  test("production 一律拒絕", () => {
    expect(() => resolveSeedTarget(["production"])).toThrow(/拒絕/);
    expect(() => resolveSeedTarget(["PRODUCTION"])).toThrow(/拒絕/);
  });

  test("未指定或不認得的目標視為錯誤，不猜測", () => {
    expect(() => resolveSeedTarget([])).toThrow(/local 或 preview/);
    expect(() => resolveSeedTarget(["https://storefront.gravito.dev"])).toThrow(/local 或 preview/);
  });
});
