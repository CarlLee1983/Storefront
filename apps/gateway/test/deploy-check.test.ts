import { describe, expect, it } from "vitest";
import { missingSecrets, parseSecretList } from "../src/deploy-check";

describe("部署前的 secrets 檢查", () => {
  it("解析 wrangler secret list --format json 的名稱", () => {
    expect(parseSecretList('[{"name":"GATEWAY_API_KEY","type":"secret_text"},{"name":"OTHER"}]')).toEqual([
      "GATEWAY_API_KEY",
      "OTHER",
    ]);
  });

  it("輸出不是 JSON 或格式不符時丟出錯誤", () => {
    expect(() => parseSecretList("oops")).toThrow("不是 JSON");
    expect(() => parseSecretList('{"name":"x"}')).toThrow("格式不符");
  });

  it("列出缺少的必要 secret；齊全時回空陣列", () => {
    expect(missingSecrets(["GATEWAY_API_KEY"])).toEqual(["GATEWAY_WEBHOOK_SECRET"]);
    expect(missingSecrets([])).toEqual(["GATEWAY_API_KEY", "GATEWAY_WEBHOOK_SECRET"]);
    expect(missingSecrets(["GATEWAY_WEBHOOK_SECRET", "GATEWAY_API_KEY"])).toEqual([]);
  });
});
