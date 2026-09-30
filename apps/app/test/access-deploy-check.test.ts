import { describe, expect, it } from "vitest";
import { checkAccessDeploy } from "../src/admin/deploy-check";

const OK = { deployEnv: "production", teamDomain: "team.cloudflareaccess.com", appVarNames: ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"], secretNames: ["GATEWAY_API_KEY"] } as const;

describe("checkAccessDeploy（部署前擋下本機專用的 Access 設定）", () => {
  it("真實團隊網域、沒有內嵌 JWKS 時沒有問題", () => {
    expect(checkAccessDeploy(OK)).toEqual([]);
  });

  it.each(["local.invalid", "anything.invalid", "TEAM.INVALID", "team.invalid."])("團隊網域 %s 是保留網域：擋下", (teamDomain) => {
    expect(checkAccessDeploy({ ...OK, teamDomain })).toEqual([expect.stringContaining("ACCESS_TEAM_DOMAIN")]);
  });

  it("wrangler.jsonc 的 vars 定義了 ACCESS_JWKS_JSON：擋下", () => {
    expect(checkAccessDeploy({ ...OK, appVarNames: [...OK.appVarNames, "ACCESS_JWKS_JSON"] })).toEqual([expect.stringContaining("ACCESS_JWKS_JSON")]);
  });

  it("App 設了名為 ACCESS_JWKS_JSON 的 secret：擋下", () => {
    expect(checkAccessDeploy({ ...OK, secretNames: [...OK.secretNames, "ACCESS_JWKS_JSON"] })).toEqual([expect.stringContaining("ACCESS_JWKS_JSON")]);
  });

  it("兩個問題同時存在時都回報", () => {
    expect(checkAccessDeploy({ ...OK, teamDomain: "local.invalid", secretNames: ["ACCESS_JWKS_JSON"] })).toHaveLength(2);
  });
});
