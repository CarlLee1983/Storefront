import { describe, expect, it } from "vitest";
import { AUTH_SECRET_NAMES } from "../src/auth/config";
import { checkAuthDeploy, parseSecretList, webOriginFromRoutes } from "../src/auth/deploy-check";

const ALL_SECRETS = [...AUTH_SECRET_NAMES];
const PREVIEW_ORIGIN = "https://preview.shop.example";

describe("webOriginFromRoutes（apps/web/wrangler.jsonc 該環境的 routes）", () => {
  it("取第一個 custom_domain 的網域組成 https origin", () => {
    expect(
      webOriginFromRoutes([
        { pattern: "example.com/*", zone_name: "example.com" },
        { pattern: "preview.shop.example", custom_domain: true },
      ]),
    ).toBe(PREVIEW_ORIGIN);
  });

  it.each([
    ["不是陣列", undefined],
    ["沒有 custom_domain", [{ pattern: "shop.example/*" }]],
    ["pattern 不是字串", [{ pattern: 1, custom_domain: true }]],
    ["空陣列", []],
  ])("%s：回傳 undefined", (_label, routes) => {
    expect(webOriginFromRoutes(routes)).toBeUndefined();
  });
});

describe("checkAuthDeploy（部署前檢查）", () => {
  it("URL 是該環境 Web 的網域、secrets 齊全時沒有問題", () => {
    expect(
      checkAuthDeploy({ deployEnv: "preview", authUrl: PREVIEW_ORIGIN, webOrigin: PREVIEW_ORIGIN, secretNames: ALL_SECRETS }),
    ).toEqual([]);
  });

  it("BETTER_AUTH_URL 空字串或未宣告都算缺", () => {
    for (const authUrl of ["", undefined]) {
      expect(
        checkAuthDeploy({ deployEnv: "preview", authUrl, webOrigin: PREVIEW_ORIGIN, secretNames: ALL_SECRETS }),
      ).toEqual(["缺少 BETTER_AUTH_URL"]);
    }
  });

  it("BETTER_AUTH_URL 不等於該環境的 Web 網域時指出期望值", () => {
    for (const authUrl of [
      "https://shop.example", // 貼到別的環境
      "http://localhost:4321",
      `${PREVIEW_ORIGIN}/`, // 結尾斜線會讓 redirect_uri 對不上
      "https://preview.shop.example:8443",
    ]) {
      expect(
        checkAuthDeploy({ deployEnv: "preview", authUrl, webOrigin: PREVIEW_ORIGIN, secretNames: ALL_SECRETS }),
      ).toEqual([`BETTER_AUTH_URL 應為 ${PREVIEW_ORIGIN}，目前是 ${authUrl}`]);
    }
  });

  it("Web 網域還是 REPLACE_WITH_ 佔位或沒有設定時，指出要先填 apps/web/wrangler.jsonc", () => {
    for (const webOrigin of [undefined, "https://REPLACE_WITH_PREVIEW_DOMAIN"]) {
      const problems = checkAuthDeploy({
        deployEnv: "preview",
        authUrl: "https://REPLACE_WITH_PREVIEW_DOMAIN",
        webOrigin,
        secretNames: ALL_SECRETS,
      });
      expect(problems).toEqual(["apps/web/wrangler.jsonc 的 env.preview.routes 尚未填入自訂網域"]);
    }
  });

  it("列出所有沒有設定的 secret", () => {
    expect(
      checkAuthDeploy({
        deployEnv: "production",
        authUrl: PREVIEW_ORIGIN,
        webOrigin: PREVIEW_ORIGIN,
        secretNames: ["BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID"],
      }),
    ).toEqual(["缺少 GOOGLE_CLIENT_SECRET", "缺少 LINE_CHANNEL_ID", "缺少 LINE_CHANNEL_SECRET"]);
  });

  it("與 parseAuthConfig 要求的 secrets 是同一份清單", () => {
    expect(
      checkAuthDeploy({ deployEnv: "production", authUrl: PREVIEW_ORIGIN, webOrigin: PREVIEW_ORIGIN, secretNames: [] }),
    ).toEqual(ALL_SECRETS.map((name) => `缺少 ${name}`));
    expect(ALL_SECRETS).toEqual([
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "LINE_CHANNEL_ID",
      "LINE_CHANNEL_SECRET",
    ]);
  });
});

describe("parseSecretList（wrangler secret list --format json）", () => {
  it("取出 secret 名稱，忽略其他欄位", () => {
    expect(
      parseSecretList('[{"name":"BETTER_AUTH_SECRET","type":"secret_text"},{"name":"LINE_CHANNEL_ID"}]'),
    ).toEqual(["BETTER_AUTH_SECRET", "LINE_CHANNEL_ID"]);
    expect(parseSecretList("[]")).toEqual([]);
  });

  it.each([
    ["不是 JSON", "Error: not logged in"],
    ["不是陣列", '{"name":"X"}'],
    ["元素沒有 name", '[{"id":"X"}]'],
    ["name 不是字串", '[{"name":1}]'],
  ])("%s：丟出錯誤，不當作沒有 secret", (_label, output) => {
    expect(() => parseSecretList(output)).toThrow();
  });
});
