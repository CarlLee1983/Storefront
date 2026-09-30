import { describe, expect, it } from "vitest";
import {
  forwardedAuthHeaders,
  hasSessionCookie,
  isAdminPath,
  isAuthPath,
  LOGIN_PATH,
  loginUrl,
  safeNextPath,
} from "./customer";

describe("isAuthPath", () => {
  it("只有 /api/auth/ 底下的路徑要轉給 App Worker", () => {
    expect(isAuthPath("/api/auth/sign-in/social")).toBe(true);
    expect(isAuthPath("/api/auth/callback/line")).toBe(true);
    expect(isAuthPath("/api/auth")).toBe(false);
    expect(isAuthPath("/api/authors")).toBe(false);
    expect(isAuthPath("/admin")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("站內相對路徑原樣保留（含查詢字串與 hash）", () => {
    expect(safeNextPath("/checkout?from=cart")).toBe("/checkout?from=cart");
    expect(safeNextPath("/checkout?from=cart#top")).toBe("/checkout?from=cart#top");
  });

  it("所有可通過的結果都是站內路徑（解析後 origin 不變）", () => {
    for (const value of ["/a", "/a/../b", "/a?next=//evil.example", "/%2F/evil.example"]) {
      const result = safeNextPath(value);
      expect(new URL(result, "https://storefront.example").origin).toBe("https://storefront.example");
    }
  });

  it.each([
    ["缺少", null],
    ["空字串", ""],
    ["外部網址", "https://evil.example/"],
    ["protocol-relative", "//evil.example/"],
    ["反斜線繞過", "/\\evil.example"],
    ["tab 被 URL 解析器吃掉（/%09/evil.example）", "/\t/evil.example"],
    ["換行被 URL 解析器吃掉（%0a）", "/\n/evil.example"],
    ["歸位字元被 URL 解析器吃掉（%0d）", "/\r/evil.example"],
    ["javascript: 網址", "javascript:alert(1)"],
    ["不是以斜線開頭", "checkout"],
  ])("%s 一律退回首頁，避免 open redirect", (_label, value) => {
    expect(safeNextPath(value)).toBe("/");
  });
});

describe("loginUrl", () => {
  it("未登入訪客被引導到登入頁，並帶著原本要去的路徑", () => {
    expect(loginUrl(new URL("https://storefront.example/checkout?from=cart"))).toBe(
      "/login?next=%2Fcheckout%3Ffrom%3Dcart",
    );
  });
});

describe("LOGIN_PATH", () => {
  it("登入頁網址以它開頭", () => {
    expect(LOGIN_PATH).toBe("/login");
    expect(loginUrl(new URL("https://storefront.example/x")).startsWith(`${LOGIN_PATH}?next=`)).toBe(true);
  });
});

describe("isAdminPath", () => {
  it("/admin 與其底下的路徑才算，別的前綴相同的路徑不算", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/products/1")).toBe(true);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isAdminPath("/checkout")).toBe(false);
  });
});

describe("hasSessionCookie", () => {
  it("有 Better Auth 的 session cookie（含 __Secure- 前綴）才算", () => {
    expect(hasSessionCookie("better-auth.session_token=abc.def")).toBe(true);
    expect(hasSessionCookie("a=b; __Secure-better-auth.session_token=abc")).toBe(true);
  });

  it("其他 cookie 或 state cookie 不算", () => {
    expect(hasSessionCookie("")).toBe(false);
    expect(hasSessionCookie("theme=dark")).toBe(false);
    expect(hasSessionCookie("better-auth.state=xyz")).toBe(false);
    expect(hasSessionCookie("x-better-auth.session_token_lookalike=1")).toBe(false);
  });
});

describe("forwardedAuthHeaders", () => {
  it("移除所有 X-Forwarded-*（不分大小寫），保留 cf-connecting-ip 與其他標頭，且不改動輸入", () => {
    const incoming = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "X-Forwarded-For": "198.51.100.1",
      "x-forwarded-host": "evil.example",
      cookie: "a=b",
    });

    const result = forwardedAuthHeaders(incoming);

    expect(Object.fromEntries(result)).toEqual({ "cf-connecting-ip": "203.0.113.7", cookie: "a=b" });
    expect(incoming.get("x-forwarded-for")).toBe("198.51.100.1");
  });
});
