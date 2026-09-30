import { describe, expect, it } from "vitest";
import { checkPaymentDeploy } from "../src/payments/deploy-check";

const OK = {
  deployEnv: "preview" as const,
  gatewayBaseUrl: "https://gateway.preview.shop.example",
  appSecretNames: ["GATEWAY_API_KEY", "BETTER_AUTH_SECRET"],
  webSecretNames: ["GATEWAY_WEBHOOK_SECRET"],
};

describe("checkPaymentDeploy（部署前檢查）", () => {
  it("閘道網址已填、App 與 Web 的 secret 齊全時沒有問題", () => {
    expect(checkPaymentDeploy(OK)).toEqual([]);
  });

  it.each([
    ["未宣告", undefined],
    ["空字串", ""],
    ["還是佔位值", "https://REPLACE_WITH_PREVIEW_GATEWAY_DOMAIN"],
    ["不是網址", "gateway.example"],
  ])("GATEWAY_BASE_URL %s：指出要填的位置", (_label, gatewayBaseUrl) => {
    const problems = checkPaymentDeploy({ ...OK, gatewayBaseUrl });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("GATEWAY_BASE_URL");
  });

  it("App 缺 GATEWAY_API_KEY、Web 缺 GATEWAY_WEBHOOK_SECRET：各指出是哪個 Worker 缺什麼", () => {
    expect(checkPaymentDeploy({ ...OK, appSecretNames: [], webSecretNames: [] })).toEqual([
      "App 缺少 GATEWAY_API_KEY",
      "Web 缺少 GATEWAY_WEBHOOK_SECRET",
    ]);
  });
});
