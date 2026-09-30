import { describe, expect, it } from "vitest";
import { readAccessJwt } from "./access-jwt";

const request = (headers: Record<string, string> = {}) => new Request("https://example.com/admin", { headers });

describe("readAccessJwt", () => {
  it("有 Cf-Access-Jwt-Assertion header 就原樣轉交", () => {
    expect(readAccessJwt(request({ "Cf-Access-Jwt-Assertion": "header.jwt.value" }), {}, false)).toBe("header.jwt.value");
  });

  it("header 優先於本機開發用的 ACCESS_DEV_JWT", () => {
    expect(readAccessJwt(request({ "Cf-Access-Jwt-Assertion": "from-header" }), { ACCESS_DEV_JWT: "dev" }, true)).toBe(
      "from-header",
    );
  });

  it("非 dev 沒有 header 時回傳空字串，即使設了 ACCESS_DEV_JWT", () => {
    expect(readAccessJwt(request(), { ACCESS_DEV_JWT: "dev" }, false)).toBe("");
  });

  it("dev 沒有 header 時使用 ACCESS_DEV_JWT", () => {
    expect(readAccessJwt(request(), { ACCESS_DEV_JWT: "dev" }, true)).toBe("dev");
  });

  it("dev 沒有 header 也沒設 ACCESS_DEV_JWT 時回傳空字串", () => {
    expect(readAccessJwt(request(), {}, true)).toBe("");
  });
});
