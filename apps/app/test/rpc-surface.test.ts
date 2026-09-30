import { describe, expect, it } from "vitest";
import { AppEntrypoint } from "../src/entrypoint";

// 呼叫不存在的 RPC 方法會讓 workerd 噴出未處理錯誤，所以直接檢查對外介面的方法名稱。
// 新增 RPC 方法時必須顯式更新這份白名單：不得出現刪除商品（商品只能下架）或覆寫在庫數（只能增減）的方法。
const RPC_METHODS = [
  "adjustStock",
  "createProduct",
  "fetch",
  "getProductForAdmin",
  "listProducts",
  "listProductsForAdmin",
  "relistProduct",
  "unlistProduct",
  "updateProduct",
];

describe("RPC 介面", () => {
  it("方法名稱符合白名單", () => {
    const methods = Object.getOwnPropertyNames(AppEntrypoint.prototype).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(RPC_METHODS);
  });
});
