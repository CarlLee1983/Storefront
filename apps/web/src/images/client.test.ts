import { describe, expect, it } from "vitest";
import { UserFacingError } from "../admin/failure";
import { errorMessage, readResult } from "./client";

const respond = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

describe("readResult", () => {
  it("成功回傳 data", async () => {
    expect(await readResult(respond({ ok: true, data: { image: 1 } }, 201))).toEqual({ image: 1 });
  });

  it("失敗丟出 UserFacingError，訊息依圖片對象不同", async () => {
    const failed = respond({ ok: false, reason: "image_upload_failed" }, 503);
    await expect(readResult(failed.clone(), "分類圖片")).rejects.toThrow(new UserFacingError("分類圖片上傳失敗，請稍後再試"));
    await expect(readResult(failed)).rejects.toThrow("商品圖片上傳失敗，請稍後再試");
  });

  it("未授權有專屬訊息；沒有專屬訊息的原因用該對象的通用訊息", async () => {
    await expect(readResult(respond({ ok: false, reason: "unauthorized" }, 403))).rejects.toThrow("沒有權限");
    await expect(readResult(respond({ ok: false, reason: "boom" }, 400), "分類圖片")).rejects.toThrow("分類圖片操作失敗，請稍後再試");
  });
});

describe("errorMessage", () => {
  it("只有 UserFacingError 的訊息會顯示，其他例外用通用訊息", () => {
    expect(errorMessage(new UserFacingError("請選擇圖片"), "失敗")).toBe("請選擇圖片");
    expect(errorMessage(new Error("請選擇圖片"), "失敗")).toBe("失敗");
    expect(errorMessage("字串", "失敗")).toBe("失敗");
  });
});
