import { describe, expect, it } from "vitest";
import { checkImagesDeploy } from "../src/images/deploy-check";

const bindings = (bucketName: string) => [{ binding: "PRODUCT_IMAGES", bucket_name: bucketName }];
const OK = { deployEnv: "preview", appBuckets: bindings("storefront-product-images-preview"), webBuckets: bindings("storefront-product-images-preview") } as const;

describe("商品圖片部署前檢查", () => {
  it("App 與 Web 同環境、同 bucket 設定通過", () => {
    expect(checkImagesDeploy(OK)).toEqual([]);
    expect(checkImagesDeploy({ deployEnv: "production", appBuckets: bindings("storefront-product-images-production"), webBuckets: bindings("storefront-product-images-production") })).toEqual([]);
  });
  it.each([undefined, null, {}, [], [null], [{ binding: "OTHER", bucket_name: "storefront-product-images-preview" }]])("缺少 binding 或格式錯誤被拒絕：%s", (appBuckets) => {
    expect(checkImagesDeploy({ ...OK, appBuckets })).toEqual([expect.stringContaining("App")]);
  });
  it("App/Web 不同 bucket、跨環境或指向 local 時被拒絕", () => {
    for (const name of ["storefront-product-images-production", "storefront-product-images-local", "", "REPLACE_WITH_BUCKET"]) {
      expect(checkImagesDeploy({ ...OK, webBuckets: bindings(name) })).toEqual([expect.stringContaining("Web")]);
    }
  });
  it("重複 PRODUCT_IMAGES 被拒絕，即使名稱相同", () => {
    expect(checkImagesDeploy({ ...OK, appBuckets: [...OK.appBuckets, ...OK.appBuckets] })).toHaveLength(1);
  });
  it("不相關的 R2 binding 不影響檢查；兩邊缺漏會一次列出", () => {
    expect(checkImagesDeploy({ ...OK, appBuckets: [...OK.appBuckets, { binding: "OTHER", bucket_name: "other" }] })).toEqual([]);
    expect(checkImagesDeploy({ deployEnv: "preview", appBuckets: undefined, webBuckets: undefined })).toHaveLength(2);
  });
});
